# Synax Electron-hosted Cua Computer Use with Optional Jev — Implementation Plan

- **Date:** 2026-09-28
- **Design:** [`docs/superpowers/specs/2026-09-28-cua-electron-hosted-optional-jev-design.md`](../specs/2026-09-28-cua-electron-hosted-optional-jev-design.md)
- **Branch:** `codex/cua-jev-optional-design`
- **Status:** Plan only; implementation has not started

## 0. Non-blocking invariant

The application must remain responsive while Cua, MCP, Jev, screenshots, and visual perception are running.

### Hard rules

- Never use `execFileSync`, `spawnSync`, synchronous native SDK calls, synchronous network requests, or synchronous image/model inference from Electron Main, Renderer, or the API request path.
- Do not put Jev or Cua calls in Electron IPC event handlers that perform CPU work. IPC handlers may await an already asynchronous lifecycle promise, but must not run a blocking loop.
- Electron Main owns only the native Cua host lifecycle. It does not run Agent planning, Jev requests, candidate ranking, screenshot parsing, or MCP tool calls.
- API Sidecar performs all MCP and Jev work through asynchronous promises with `AbortSignal` cancellation and bounded timeouts.
- Visual perception runs in Cua's contained extension/worker process. Synax only validates its bounded result; it does not decode or infer screenshots on the Electron main thread.
- Every long-lived operation has cancellation, a timeout, and a bounded result size.
- UI startup must show a non-blocking `starting`/`unavailable` status instead of freezing the window while Cua initializes.

### Responsiveness acceptance targets

- Electron Main event-loop delay must remain below 50 ms during a Cua action request under normal desktop conditions.
- No synchronous filesystem or process operation may be introduced into the main-process Cua path.
- A slow Cua start, MCP handshake, Jev request, or visual parse must not prevent window creation, menu interaction, or renderer repaint.
- A canceled Agent Session must cancel pending Jev/MCP work where the underlying protocol supports cancellation and must prevent any new side-effect action from starting.

## 1. Workstream A — Configuration and strategy resolution

### Files

- `api/lib/config/config-types.ts`
- `api/lib/config/project-settings-types.ts`
- `api/lib/config/project-settings-store.ts`
- `api/routes/project-settings.ts`
- `api/services/computer-use/computer-use-config.ts` (new)
- `api/services/computer-use/computer-use-strategy.ts` (new)
- Related config tests

### Tasks

1. Add project-owned Computer Use configuration with safe defaults:

   ```ts
   type ComputerUseStrategy = "auto" | "direct" | "jev";
   type JevFallback = "direct" | "fail_closed";
   type PerceptionMode = "disabled" | "auto" | "required";
   ```

2. Keep Jev credentials out of plain project settings. Store only a provider-connection reference and non-secret options such as model and fallback policy.
3. Implement `resolveComputerUseStrategy()`:
   - absent/disabled Jev in `auto` → `direct`;
   - explicit `direct` → `direct`;
   - explicit `jev` without valid config → configuration error;
   - configured Jev runtime failure → configured fallback only.
4. Ensure resolving strategy is synchronous and side-effect free. It must not initialize a client or make a network request.
5. Add config migration/default tests.

### Non-blocking notes

- Strategy resolution reads already-loaded settings only.
- Secret/provider lookup is deferred until a Jev-mode Agent Tool call, never during Electron startup.

## 2. Workstream B — Electron-owned Cua runtime

### Files

- `electron/lib/cua-runtime.ts` (new)
- `electron/main.ts`
- `electron/lib/node-sidecar.ts`
- `electron/preload.ts` only if status IPC is needed
- `electron/tsconfig.json`
- `forge.config.ts`
- Electron lifecycle tests

### Tasks

1. Add `CuaRuntimeManager` with:

   ```ts
   start(): Promise<CuaMcpConnection>;
   restart(): Promise<CuaMcpConnection>;
   stop(): Promise<void>;
   status(): CuaRuntimeStatus;
   ```

2. Use promise coalescing so concurrent callers share one start operation rather than spawning multiple hosts.
3. Resolve the Cua executable path asynchronously from development override or packaged resources.
4. Start `EmbeddedCuaDriverHost` only from Electron Main, preserving macOS TCC ownership.
5. Return a generation-scoped connection object containing the exact MCP command, args, environment, and generation identifier.
6. Do not run Jev, Agent logic, or MCP tool calls in this manager.
7. Start the Cua host asynchronously in the existing desktop bootstrap. Do not use synchronous process/file calls.
8. If startup is slow or fails, keep Electron responsive and expose status/error state to the renderer.
9. On restart, atomically replace the connection generation and invalidate the old one.
10. During app shutdown, stop accepting new work, await sidecar/MCP shutdown, then stop the Cua driver host.

### Important startup choice

Cua startup must be lazy or backgrounded. The current `app:api-port` IPC handler awaits `startSidecar()`. The implementation must ensure that Cua startup does not run synchronously inside this handler:

- preferred: begin Cua initialization in the background after `app.whenReady()` and let `startSidecar()` await the asynchronous promise only when the sidecar actually needs the connection;
- if the connection is not ready, return a clear `starting` state to the UI and keep retry/continuation asynchronous;
- do not perform CPU-heavy setup before creating the BrowserWindow.

## 3. Workstream C — Sidecar bootstrap and runtime-only Cua MCP

### Files

- `electron/lib/node-sidecar.ts`
- `api/server.ts`
- `api/services/mcp/mcp-client-manager.ts`
- `api/services/mcp/mcp-transport.ts`
- `api/services/mcp/runtime-cua-config.ts` (new)
- Sidecar bootstrap tests

### Tasks

1. Extend `startSidecar()` to receive an optional generation-scoped Cua MCP connection.
2. Transfer bootstrap data over a controlled local channel. Use environment injection only as a development fallback, not as the long-term production protocol.
3. Validate the bootstrap payload before use:
   - command is absolute or explicitly trusted;
   - args are an array of strings;
   - environment values are not logged;
   - generation is non-empty;
   - no user-supplied URL or shell interpolation is accepted.
4. Register the Cua MCP configuration as runtime-only and internal-capable. Do not persist it to project settings or show it as an editable user MCP server.
5. On generation change, close old Cua MCP clients before accepting new Agent work.
6. Add a graceful sidecar shutdown hook that closes MCP clients before process exit.

### Non-blocking notes

- Bootstrap parsing is bounded JSON validation only.
- Never execute a shell command through `sh -c` for the Cua MCP command.
- Never block the Electron process while the sidecar waits for MCP handshake.

## 4. Workstream D — MCP fidelity, retry, and session isolation

### Files

- `api/services/mcp/mcp-client-manager.ts`
- `api/services/mcp/mcp-session-tool-provider.ts`
- `api/services/mcp/mcp-transport.ts`
- `api/lib/config/config-types.ts`
- `api/services/agent-runtime/loop-runtime.ts`
- `api/services/agent-runtime/contracts.ts` only if a runtime metadata type is needed
- Existing MCP tests plus new Cua contract tests

### Tasks

1. Extend `McpRuntimeToolDef` to retain `inputSchema`, `outputSchema`, and relevant annotations.
2. Convert a valid MCP `inputSchema` using `z.fromJSONSchema`; retain the generic catch-all fallback for malformed schemas.
3. Preserve `structuredContent`, `isError`, and structured Cua refusal/verification metadata in `ToolExecutionResult.result`.
4. Continue importing image content through `media-tool-content.ts`; enforce existing byte limits and add Cua screenshot cases.
5. Add `McpLifecycle: "project" | "session"`. Cua uses `session`.
6. Include `sessionId` in the Cua client cache key and call path without changing existing project-scoped MCP behavior.
7. Add a retry policy:
   - observations may retry once when the failure is known to occur before dispatch;
   - side-effect Cua tools never auto-replay after an ambiguous transport error;
   - return an explicit unknown-outcome result that instructs the Agent to reobserve.
8. Add cancellation propagation from `ToolExecutionInput.abortSignal` to MCP call timeout/transport where supported.
9. Ensure all timeout timers are cleared in both success and failure paths.
10. Add tests proving that two sessions receive different Cua connections and that a dropped action response never triggers a duplicate action.

### Non-blocking notes

- MCP calls remain async through the SDK transport.
- Do not stringify or deeply clone unbounded `structuredContent` on the hot path; cap displayed summaries and persist only validated/bounded fields.
- Large screenshots are stored as assets through the existing async asset path and are not decoded in Electron Main.

## 5. Workstream E — Direct Cua mode

### Files

- `api/services/agent-runtime/tool-registry.ts`
- `api/services/mcp/mcp-session-tool-provider.ts`
- `api/services/computer-use/cua-direct-adapter.ts` (new)
- `api/skills/builtin/computer-use/SKILL.md` (new)
- Direct-mode tests

### Tasks

1. Preserve the existing Direct Cua path as the default when Jev is absent.
2. Mount the Cua MCP server per Native Agent Session.
3. Provide the Cua Computer Use skill with observe → act → verify guidance.
4. Keep Synax's existing explicit MCP permission behavior.
5. Ensure Direct Cua can call observation and action tools without importing the Jev package or reading a Jev API key.
6. Add smoke coverage for Calculator and a simple browser form.

### Non-blocking notes

- Direct Cua tool calls execute through the API sidecar, not Electron Main.
- The Agent receives asynchronous tool progress/events already supported by the runtime.
- A slow Cua action must not block unrelated Electron UI events.

## 6. Workstream F — Optional Jev decision service

### Files

- `api/services/computer-use/jev-decision-service.ts` (new)
- `api/services/computer-use/jev-envelope.ts` (new)
- `api/services/computer-use/cua-jev-adapter.ts` (new)
- `api/services/computer-use/computer-use-controller.ts` (new)
- `api/services/computer-use/cua-candidate-builder.ts` (new)
- `api/services/agent-runtime/tools/computer-use.ts` (new)
- `api/services/agent-runtime/tool-registry.ts`
- Jev adapter tests

### Tasks

1. Add a provider interface:

   ```ts
   interface JevDecisionService {
     choose(input: JevChoiceRequest, signal?: AbortSignal): Promise<JevChoiceResponse>;
   }
   ```

2. Implement `MockJevDecisionService` first. It must be deterministic, credential-free, and suitable for unit/integration tests.
3. Implement `LiveJevDecisionService` with lazy client initialization. It must not initialize unless strategy resolution selects Jev mode.
4. Use an async TypeSafe Jev client in the API sidecar. Do not put it in Electron Main or Renderer.
5. Set bounded request timeouts and cancellation using `AbortSignal.timeout()`/composed signals.
6. Redact credentials and sensitive values before logging or returning diagnostics.
7. Build complete candidate actions in Synax. Include `reobserve` and `abstain` choices.
8. Validate every response before resolving it to an action.
9. Enforce one side-effect action per `computer.use` call.
10. Reobserve and verify after every selected action.
11. Keep raw Cua tools internal to the controller while Jev mode is active.
12. If no Jev configuration is present, do not construct this service and do not alter Direct mode.
13. If Jev is explicitly configured but unavailable, apply only the configured fallback policy.

### Non-blocking notes

- One Jev request is one async HTTP/SDK operation with timeout and abort support.
- Candidate construction must be bounded by maximum candidates, description length, history length, and observation size.
- No screenshot bytes are sent to Jev by default; use compact semantic data and validated visual-region metadata only.
- The controller must yield through async awaits between observe, choose, permission, execute, and verify stages.

## 7. Workstream G — Optional visual perception

### Files

- `api/services/computer-use/cua-visual-adapter.ts` (new)
- `api/services/computer-use/cua-observation-adapter.ts` (new)
- `api/services/computer-use/cua-candidate-builder.ts`
- Project settings/config files
- Visual adapter tests

### Tasks

1. Detect `parse_visual_regions` and capture-bound click capability from the discovered Cua tool catalog.
2. Keep visual perception disabled by default.
3. Use semantic DOM/Accessibility evidence first.
4. When enabled, bind `get_window_state` capture → `parse_visual_regions` → click to the same `capture_id`.
5. Validate region schema, dimensions, bounds, confidence, uniqueness, interactivity, and source window identity.
6. Reject stale, ambiguous, malformed, or mismatched visual results without retrying as an unbound coordinate click.
7. Do not run OCR/icon inference in Synax's main process. Treat Cua's contained worker as the inference boundary.
8. Keep extension installation and licensing separate from the base Direct Cua rollout.

## 8. Workstream H — UI and runtime status

### Files

- `web/src/react/features/settings/components/` Computer Use settings component (new)
- `web/src/lib/contracts/project-settings.ts`
- `web/src/lib/i18n.ts`
- Existing Agent capability/session panels
- Electron IPC/preload only for Cua status if required

### Tasks

1. Add project-level Computer Use settings:
   - enabled;
   - strategy: auto/direct/jev;
   - Jev provider/model reference;
   - Jev fallback;
   - perception mode.
2. Do not expose secret values in the UI after save.
3. Show non-blocking runtime states:
   - starting;
   - ready;
   - permission required;
   - unavailable;
   - restarting;
   - stopped.
4. Make Direct Cua available even when Jev is not configured.
5. Add explicit messaging when `strategy=jev` lacks a valid Jev connection.
6. Never block renderer interaction while Cua status is being queried.

## 9. Workstream I — Lifecycle and shutdown integration

### Files

- `api/services/mcp/mcp-client-manager.ts`
- `api/server.ts`
- `electron/main.ts`
- `electron/lib/node-sidecar.ts`
- Cua lifecycle tests

### Tasks

1. Add `mcpClientManager.closeAll()` to API shutdown before releasing the runtime host.
2. Stop accepting new Cua work before closing Cua clients.
3. Await active Agent interruptions using existing runtime behavior.
4. Close session-scoped Cua MCP transports.
5. Stop sidecar only after it has closed its own Cua MCP clients.
6. Stop the Electron-hosted Cua Runtime after sidecar shutdown.
7. Make shutdown idempotent and safe when startup is still pending.
8. Avoid force-killing an in-flight Cua action until the runtime is already in application shutdown.

## 10. Workstream J — Packaging and development overrides

### Files

- `forge.config.ts`
- `electron/lib/cua-runtime.ts`
- `scripts/` platform packaging helpers
- `package.json` and lockfile only if dependency choice requires it
- Desktop packaging tests

### Tasks

1. Support `SYNAX_CUA_DRIVER_PATH` for local development.
2. Add packaged-resource lookup for the Cua executable.
3. Keep the Cua executable outside ASAR.
4. Preserve executable permissions.
5. Add platform/architecture validation before starting the host.
6. Keep Jev client configuration independent of Cua binary packaging.
7. Do not bundle `cua-perception` in the base artifact until license and release decisions are complete.
8. Add packaging tests that verify no `.DS_Store` files enter the artifact or Git history.

## 11. Test and verification order

Run verification in this order to keep failures localized:

1. `npm run typecheck`
2. targeted MCP contract tests
3. targeted strategy/config tests
4. targeted Jev mock/controller tests
5. targeted Electron lifecycle tests
6. `npm test -- --runInBand` equivalent supported by the repository's Vitest configuration
7. `npm run test:desktop`
8. Direct Cua desktop smoke test with an external Cua Driver binary
9. Jev mock desktop smoke test
10. packaged desktop smoke test on each supported platform

The implementation must not claim Jev live-path verification without a configured test credential; mock and Direct Cua paths must remain fully verifiable offline.

## 12. Suggested implementation commits

Keep commits small and independently reviewable:

1. `feat: add non-blocking cua runtime lifecycle manager`
2. `feat: inject generation-scoped cua mcp into sidecar`
3. `fix: preserve mcp schemas and structured results`
4. `fix: isolate cua mcp sessions and suppress unsafe retries`
5. `feat: add direct cua strategy and computer use skill`
6. `feat: add optional jev decision controller`
7. `feat: add optional visual-region adapter`
8. `feat: add computer use settings and runtime status`
9. `test: add desktop direct and jev mock smoke coverage`

Do not mix packaging, visual perception, or live Jev credentials into the first Direct Cua implementation commit.

## 13. Definition of done

- Direct Cua works with no Jev configuration and no Jev network request.
- Electron Main remains responsive during Cua startup, MCP handshakes, Cua actions, Jev requests, and runtime restart.
- No synchronous native/process/network/image inference work exists in the main-process Cua path.
- Each Cua Agent Session uses an isolated MCP lifecycle connection.
- Cua tool schemas and structured results are available to Direct mode.
- Cua side effects are never automatically replayed after an ambiguous failure.
- Jev mode is opt-in, bounded, cancellable, and mock-testable.
- Jev failure behavior follows explicit fallback configuration.
- Optional visual perception is disabled by default and capture-bound when enabled.
- Shutdown closes Cua MCP clients before stopping the Cua Runtime.
- No `.DS_Store` file is tracked.
