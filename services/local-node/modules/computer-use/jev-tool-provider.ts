import * as z from 'zod/v4';
import type { RegisteredTool, SessionToolProvider } from '../agent-runtime/contracts.js';
import { agentRuntimeStore } from '../agent-runtime/session-store.js';
import { CUA_SERVER_ID, getRuntimeCuaConfig } from '../../infrastructure/mcp/runtime-cua-config.js';
import { mcpClientManager } from '../../infrastructure/mcp/mcp-client-manager.js';
import { configuredJevProviderId, resolveJevCredentials } from './jev-credentials.js';
import { resolveComputerUseStrategy } from './strategy.js';
import { enableDirectFallback } from './fallback.js';
import { desktopVisualCandidates, visualCandidates } from './visual-regions.js';
import { LiveJevDecisionService, MockJevDecisionService, JevInvalidDecisionError, validateJevDecision, type Candidate, type JevDecisionService } from './jev-decision.js';
import { resolveEffectiveComputerUseSettings } from './effective-settings.js';

const schema = z.object({
  goal: z.string().min(1).max(2000),
  pid: z.number().int().positive(),
  windowId: z.number().int().positive(),
  text: z.string().max(1000).optional(),
}).strict();

type CuaWindowObservation = {
  degraded?: unknown;
  error?: unknown;
  errors?: unknown;
  reason?: unknown;
  elements?: unknown;
};

/**
 * A CUA process can be alive while macOS has denied the capabilities needed to
 * resolve a native window. Do not turn that state into an empty candidate list:
 * an empty list makes Jev choose `abstain` and hides the actionable permission
 * error from the user.
 */
export function describeCuaObservationFailure(structured: unknown): string | null {
  if (!structured || typeof structured !== 'object') {
    return 'CUA Driver returned no window observation. Grant the Synax CUA helper Accessibility and Screen Recording permissions in macOS System Settings, then retry Computer Use. Synax itself does not need these permissions.';
  }
  const state = structured as CuaWindowObservation;
  if (state.degraded === true) {
    const detail = [state.error, state.reason, state.errors]
      .flatMap(value => Array.isArray(value) ? value : [value])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('; ');
    return `CUA Driver is running in degraded mode${detail ? ` (${detail})` : ''}. Grant the Synax CUA helper Accessibility and Screen Recording permissions in macOS System Settings, then retry Computer Use. Synax itself does not need these permissions.`;
  }
  return null;
}

type DesktopCapture = { captureId: string; displayId: string };

/** Long-edge cap for the fallback capture: readable for Jev without shipping a full 2x frame. */
const DESKTOP_CAPTURE_MAX_DIMENSION = 1280;

/**
 * Capture the primary desktop. The Driver documents `display_id="primary"` as
 * the portable desktop target, so that is the only display this path addresses.
 */
async function observeDesktopCapture(projectId: string | undefined, sessionId: string, signal?: AbortSignal): Promise<DesktopCapture | null> {
  const capture = await mcpClientManager.callTool(
    CUA_SERVER_ID, 'get_desktop_state', { max_image_dimension: DESKTOP_CAPTURE_MAX_DIMENSION }, projectId, sessionId, signal,
  );
  const state = capture.structuredContent as { capture_id?: unknown; display?: unknown } | undefined;
  const captureId = state?.capture_id;
  if (!capture.ok || typeof captureId !== 'string' || !captureId) return null;
  const displayId = typeof state?.display === 'string' && state.display.trim() ? state.display.trim() : 'primary';
  return { captureId, displayId };
}

/**
 * Window-scoped grounding can fail while the desktop capture registry still
 * works (macOS 27 exposes no AX window for the target and refuses window
 * captures). Re-ground on capture-bound desktop visual regions so Jev keeps
 * deciding real Cua actions instead of collapsing to `abstain`.
 */
async function desktopObservationCandidates(projectId: string | undefined, sessionId: string, signal?: AbortSignal): Promise<{ candidates: Candidate[]; capture: DesktopCapture } | null> {
  const capture = await observeDesktopCapture(projectId, sessionId, signal);
  if (!capture) return null;
  const parsed = await mcpClientManager.callTool(
    CUA_SERVER_ID, 'parse_visual_regions',
    { capture_id: capture.captureId, options: { kinds: ['text', 'icon'], min_confidence: 0.8, max_regions: 100 } },
    projectId, sessionId, signal,
  );
  if (!parsed.ok) return null;
  return { candidates: desktopVisualCandidates(parsed.structuredContent, capture.captureId, capture.displayId), capture };
}

function standaloneCandidates(reobserve: string): Candidate[] {
  return [{ id: 'reobserve', description: reobserve }, { id: 'abstain', description: 'Stop: insufficient evidence' }];
}

export function makeCandidates(structured: unknown, pid: number, windowId: number, text?: string): Candidate[] {
  if (!structured || typeof structured !== 'object') return [{ id: 'reobserve', description: 'Reobserve the window' }, { id: 'abstain', description: 'Stop: insufficient evidence' }];
  const state = structured as { snapshot_id?: unknown; elements?: unknown };
  const snapshotId = typeof state.snapshot_id === 'string' ? state.snapshot_id : undefined;
  const elements = Array.isArray(state.elements) ? state.elements : [];
  const result: Candidate[] = [];
  if (snapshotId) for (const raw of elements.slice(0, 80)) {
    if (!raw || typeof raw !== 'object') continue;
    const element = raw as Record<string, unknown>;
    const index = element.element_index;
    const label = typeof element.label === 'string' ? element.label.trim().slice(0, 120) : '';
    const role = typeof element.role === 'string' ? element.role.toLowerCase() : '';
    if (!Number.isInteger(index) || (index as number) < 0 || !label) continue;
    if (['button', 'checkbox', 'radio', 'link', 'menu item'].some(kind => role.includes(kind))) {
      result.push({ id: `click_${index}`, description: `Click ${label} (${role})`, tool: 'click', args: { pid, window_id: windowId, snapshot_id: snapshotId, element_index: index, delivery_mode: 'foreground' } });
    }
    if (text && ['text field', 'textfield', 'input', 'textbox'].some(kind => role.includes(kind))) {
      result.push({ id: `type_${index}`, description: `Type the user-provided text into ${label}`, tool: 'type_text', args: { pid, window_id: windowId, snapshot_id: snapshotId, element_index: index, text, delivery_mode: 'foreground' } });
    }
    if (result.length >= 30) break;
  }
  return [...result, { id: 'reobserve', description: 'Reobserve the current window' }, { id: 'abstain', description: 'Stop without taking an action' }];
}

export const jevSessionToolProvider: SessionToolProvider = {
  id: 'synax-computer-use-jev',
  getTools(sessionId) {
    const session = agentRuntimeStore.tryGetSession(sessionId);
    if (!session || !getRuntimeCuaConfig()) return [];
    const settings = resolveEffectiveComputerUseSettings(session.projectId);
    try { if (resolveComputerUseStrategy(settings) !== 'jev') return []; } catch { return []; }
    const tool: RegisteredTool = {
      id: 'computer.use', label: 'Computer Use (Jev)', category: 'mcp', mutability: 'task', resumeBehavior: 'wait_permission',
      description: 'Observe the target Cua window, ask Jev to choose from complete semantic actions, execute at most one approved action, and reobserve. When the window surface cannot be resolved at all — as on macOS 27, where the target exposes no AX window and window captures are refused — observe the primary desktop instead and let Jev decide from capture-bound visual regions. Requires TypeSafe Jev API configuration. Does not access arbitrary coordinates.',
      progressiveDetails: 'Accepts { goal, pid, windowId, text? }. Use the exact process/window IDs from a current Cua observation; stale or inaccessible windows may fail. text is only for the requested typing action. A single side-effect action per call. If evidence is absent, abstain. If Direct Cua fallback is returned, wait for its tools to mount on the next step and use those available tool names. Window-scoped grounding failures fall back to a capture-bound primary-desktop observation whose click candidates carry scope:"desktop"; the result reports which scope was used. Requires the Cua runtime and a configured Jev provider connection.',
      inputSchema: schema,
      async execute(input) {
        const args = schema.parse(input.args);
        input.abortSignal?.throwIfAborted();
        const configured = resolveEffectiveComputerUseSettings(session.projectId);
        if (resolveComputerUseStrategy(configured) !== 'jev' || !getRuntimeCuaConfig()) throw new Error('Jev Computer Use is unavailable');
        const credentials = resolveJevCredentials();
        const mock = process.env.NODE_ENV !== 'production' && process.env.SYNAX_JEV_MOCK === '1';
        if (!credentials && !mock) {
          const providerId = configuredJevProviderId();
          throw new Error(providerId
            ? `Jev is enabled with provider "${providerId}" but that provider connection has no API key: add one under Settings -> Providers, or set TYPESAFE_API_KEY`
            : 'Jev is enabled but no Jev API key is configured: set it in Settings -> Computer Use, or set TYPESAFE_API_KEY for the API sidecar');
        }
        const observer = await mcpClientManager.callTool(CUA_SERVER_ID, 'get_window_state', { pid: args.pid, window_id: args.windowId, include_screenshot: false, max_elements: 80 }, session.projectId, sessionId, input.abortSignal);
        const observationFailure = observer.ok
          ? describeCuaObservationFailure(observer.structuredContent)
          : (observer.error ?? 'Cua observation failed');
        let scope: 'window' | 'desktop' = 'window';
        let desktopCapture: DesktopCapture | null = null;
        let candidates: Candidate[];
        if (observationFailure) {
          const fallback = await desktopObservationCandidates(session.projectId, sessionId, input.abortSignal)
            .catch((error: unknown) => {
              throw new Error(
                `${observationFailure} Desktop fallback also failed: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
              );
            });
          // Fail closed with the original, actionable reason when the desktop
          // capture registry is unavailable too.
          if (!fallback) throw new Error(observationFailure);
          scope = 'desktop';
          desktopCapture = fallback.capture;
          candidates = [...fallback.candidates, ...standaloneCandidates('Reobserve the primary desktop')];
        } else {
          candidates = makeCandidates(observer.structuredContent, args.pid, args.windowId, args.text);
        }
        if (scope === 'window' && configured.perception !== 'disabled' && !candidates.some(candidate => candidate.tool)) {
          const tools = mcpClientManager.getCachedTools(CUA_SERVER_ID, session.projectId, sessionId);
          const parser = tools.find(tool => tool.name === 'parse_visual_regions');
          const click = tools.find(tool => tool.name === 'click');
          const captureBound = !!click?.inputSchema &&
            JSON.stringify(click.inputSchema).includes('capture_id');
          if (!parser || !captureBound) {
            if (configured.perception === 'required') throw new Error('Cua capture-bound visual perception is unavailable');
          } else {
            const capture = await mcpClientManager.callTool(CUA_SERVER_ID, 'get_window_state',
              { pid: args.pid, window_id: args.windowId, include_accessibility_tree: false },
              session.projectId, sessionId, input.abortSignal);
            const captureId = (capture.structuredContent as { capture_id?: unknown } | undefined)?.capture_id;
            if (!capture.ok || typeof captureId !== 'string') {
              if (configured.perception === 'required') throw new Error(capture.error ?? 'Cua capture unavailable');
            } else {
              const parsed = await mcpClientManager.callTool(CUA_SERVER_ID, 'parse_visual_regions',
                { capture_id: captureId, options: { kinds: ['text', 'icon'], min_confidence: 0.8, max_regions: 100 } },
                session.projectId, sessionId, input.abortSignal);
              if (!parsed.ok) {
                if (configured.perception === 'required') throw new Error(parsed.error ?? 'Cua visual parsing unavailable');
              } else {
                const visual = visualCandidates(parsed.structuredContent, captureId, args.pid, args.windowId);
                candidates = [...visual, ...candidates];
              }
            }
          }
        }
        const compactObservation = JSON.stringify({
          pid: args.pid,
          window_id: args.windowId,
          scope,
          ...(desktopCapture ? { display_id: desktopCapture.displayId } : {}),
          ...(observationFailure ? { window_observation_error: observationFailure } : {}),
          elements: candidates.filter(candidate => candidate.tool).map(candidate => ({ id: candidate.id, description: candidate.description })),
        }).slice(0, 12_000);
        const client: JevDecisionService = mock
          ? new MockJevDecisionService()
          : new LiveJevDecisionService({
              apiKey: credentials!.apiKey,
              ...(credentials!.baseURL ? { baseURL: credentials!.baseURL } : {}),
              ...(credentials!.model ? { model: credentials!.model } : {}),
            });
        const timeout = AbortSignal.timeout(15_000);
        const signal = input.abortSignal ? AbortSignal.any([input.abortSignal, timeout]) : timeout;
        let decision;
        try {
          decision = validateJevDecision(await client.choose({ goal: args.goal, observation: compactObservation, candidates }, signal), candidates);
        } catch (error) {
          if (error instanceof JevInvalidDecisionError || configured.jev?.fallback !== 'direct' || input.abortSignal?.aborted) throw error;
          enableDirectFallback(sessionId);
          return {
            result: { acted: false, fallback: 'direct', reason: 'Jev unavailable; use Direct Cua tools after they are mounted on the next step.' },
            displaySummary: 'Jev unavailable; Direct Cua fallback enabled for this session', artifacts: [],
          };
        }
        const selected = candidates.find(c => c.id === decision.selectedId)!;
        if (!selected.tool || !selected.args) return { result: { selected: selected.id, acted: false }, displaySummary: `Jev selected ${selected.id}; no action taken`, artifacts: [] };
        signal.throwIfAborted();
        const executed = await mcpClientManager.callTool(CUA_SERVER_ID, selected.tool, selected.args, session.projectId, sessionId, signal);
        if (!executed.ok) throw new Error(executed.error ?? 'Cua action failed; reobserve before retrying');
        const after = scope === 'desktop'
          ? await mcpClientManager.callTool(CUA_SERVER_ID, 'get_desktop_state', { max_image_dimension: DESKTOP_CAPTURE_MAX_DIMENSION }, session.projectId, sessionId, input.abortSignal)
          : await mcpClientManager.callTool(CUA_SERVER_ID, 'get_window_state', { pid: args.pid, window_id: args.windowId, include_screenshot: false, max_elements: 80 }, session.projectId, sessionId, input.abortSignal);
        const afterFailure = after.ok ? describeCuaObservationFailure(after.structuredContent) : (after.error ?? 'Cua observation failed');
        const verified = after.ok && !afterFailure;
        return {
          result: {
            acted: true, scope, selected: selected.id, confidence: decision.confidence,
            action: executed.structuredContent, after: after.structuredContent,
            verification: verified ? 'fresh_observation' : 'unverified',
            ...(verified ? {} : { observationError: afterFailure }),
          },
          displaySummary: `Jev selected ${selected.id}; ${verified ? (scope === 'desktop' ? 'fresh primary-desktop capture taken' : 'fresh window state captured') : 'post-action verification unavailable'}`,
          artifacts: [],
        };
      },
    };
    return [tool];
  },
  getHooks: () => [],
};
