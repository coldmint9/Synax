import * as z from 'zod/v4';
import type { RegisteredTool, SessionToolProvider } from '../agent-runtime/contracts.js';
import { agentRuntimeStore } from '../agent-runtime/session-store.js';
import { CUA_SERVER_ID, getRuntimeCuaConfig } from '../mcp/runtime-cua-config.js';
import { mcpClientManager } from '../mcp/mcp-client-manager.js';
import { configuredJevProviderId, resolveJevCredentials } from './jev-credentials.js';
import { resolveComputerUseStrategy } from './strategy.js';
import { enableDirectFallback } from './fallback.js';
import { visualCandidates } from './visual-regions.js';
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
    return 'CUA Driver returned no window observation. Grant Synax Accessibility and Screen Recording permissions, then restart Synax.';
  }
  const state = structured as CuaWindowObservation;
  if (state.degraded === true) {
    const detail = [state.error, state.reason, state.errors]
      .flatMap(value => Array.isArray(value) ? value : [value])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('; ');
    return `CUA Driver is running in degraded mode${detail ? ` (${detail})` : ''}. Grant Synax Accessibility and Screen Recording permissions, then restart Synax.`;
  }
  return null;
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
      result.push({ id: `click_${index}`, description: `Click ${label} (${role})`, tool: 'click', args: { pid, window_id: windowId, snapshot_id: snapshotId, element_index: index, delivery_mode: 'background' } });
    }
    if (text && ['text field', 'textfield', 'input', 'textbox'].some(kind => role.includes(kind))) {
      result.push({ id: `type_${index}`, description: `Type the user-provided text into ${label}`, tool: 'type_text', args: { pid, window_id: windowId, snapshot_id: snapshotId, element_index: index, text, delivery_mode: 'background' } });
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
      description: 'Observe one exact Cua window, ask Jev to choose from complete semantic actions, execute at most one approved action, and reobserve. Requires TypeSafe Jev API configuration. Does not access arbitrary coordinates.',
      progressiveDetails: 'Accepts { goal, pid, windowId, text? }. A single side-effect action per call. If evidence is absent, abstain.',
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
        if (!observer.ok) throw new Error(observer.error ?? 'Cua observation failed');
        const observationFailure = describeCuaObservationFailure(observer.structuredContent);
        if (observationFailure) throw new Error(observationFailure);
        let candidates = makeCandidates(observer.structuredContent, args.pid, args.windowId, args.text);
        if (configured.perception !== 'disabled' && !candidates.some(candidate => candidate.tool)) {
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
        const after = await mcpClientManager.callTool(CUA_SERVER_ID, 'get_window_state', { pid: args.pid, window_id: args.windowId, include_screenshot: false, max_elements: 80 }, session.projectId, sessionId, input.abortSignal);
        const afterFailure = after.ok ? describeCuaObservationFailure(after.structuredContent) : null;
        return {
          result: { acted: true, selected: selected.id, confidence: decision.confidence, action: executed.structuredContent, after: after.structuredContent, verification: after.ok && !afterFailure ? 'fresh_observation' : 'unverified', observationError: after.error ?? afterFailure },
          displaySummary: `Jev selected ${selected.id}; ${after.ok && !afterFailure ? 'fresh window state captured' : 'post-action verification unavailable'}`,
          artifacts: [],
        };
      },
    };
    return [tool];
  },
  getHooks: () => [],
};
