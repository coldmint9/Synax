# Explicit Streaming Commit Message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users select an API model, explicitly generate a history-aware commit message into the editor through a cancellable text stream, and submit only a reviewed nonempty message.

**Architecture:** A read-only Git context collector and a session-scoped SSE generation service share existing session/repository validation with the commit flow. The client uses a focused stream parser, a project-scoped model preference, and a HeroUI icon button in the existing dialog; commit and push remain a separate explicit action.

**Tech Stack:** TypeScript, Hono SSE, AI SDK gateway, Git subprocesses, React, HeroUI v3, Zustand, Vitest/Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-21-explicit-streaming-commit-message-design.md`

## Global Constraints

- Generate only on explicit star-button press; neither submit button may call an LLM.
- Read history from the selected repository's current branch: at most 20 nonempty `git log` subjects. No training or persistent history storage.
- Generation must not call `git add`, `commit`, or `push`; use bounded diff/status/history inputs and never log sensitive request material.
- Only configured API models; first-use selection is the session model, then the last manually selected model per project if still available.
- Thinking is on by default. Do not send `thinking.type: disabled` to GLM-5.3; do not inject unsupported reasoning fields for other models.
- On failure, cancellation, closure or root/session switch, restore the pre-generation editor text and reject stale chunks.
- Existing worktree contains unrelated changes, notably `web/src/lib/api/agentRuntime.ts` and `web/src/lib/i18n.ts`. Preserve them; stage only task-specific hunks, never `git add -A`. Use an isolated worktree only if its lack of uncommitted changes will not hide required concurrent edits.
- Never exercise commit/push against a real user's repository; integration tests use disposable fixtures. Run format/type/test/build checks after integration.

## File map and interface contracts

- `api/services/agent-runtime/session-commit-message-context.ts` (new): bounded read-only Git context, `collectCommitMessageContext(sessionId, rootId?)` returning `{ projectId, branch, changedFiles, stagedSummary, unstagedSummary, diffExcerpt, subjects }`.
- `api/services/agent-runtime/session-commit-message-stream.ts` (new): `prepareCommitMessageGeneration(sessionId, { rootId?, model }): Promise<PreparedCommitMessageGeneration>` validates before SSE; `streamSessionCommitMessage(prepared, signal): AsyncGenerator<CommitMessageEvent>`; `CommitMessageEvent` is `{ type: "delta"; text: string } | { type: "final"; message: string }`.
- `api/services/agent-runtime/session-git-commit.ts`: keep Git commit/push, require an explicit nonempty message and delete its embedded LLM generation. Share existing message normalizer with the new service.
- `api/services/llm-runtime/thinking-mode-strategy.ts`: route the explicit `reasoningEffort` for reasoning-capable OpenAI-compatible custom models through their provider namespace.
- `api/routes/agent-runtime.ts`: validate the separate stream request; send `delta`, `final`, `error`, `[DONE]` SSE frames; require a message in the existing commit schema.
- `web/src/lib/api/agentRuntime.ts`: typed stream client accepting `AbortSignal` and incremental event callback; existing commit API stays separate.
- `web/src/react/features/agent-workspace/commitMessageModelPreference.ts` (new): project-scoped persisted API model choice and pure fallback selector.
- `web/src/react/features/agent-workspace/SessionCommitDialog.tsx`: API-only model picker, `isIconOnly` star button, editor stream state and submit guards.
- `web/src/react/features/agent-workspace/WorkspaceDashboard.tsx`: pass `environment.projectId` to the dialog.
- `web/src/lib/i18n.ts`: Chinese and English strings for selection, generation, cancellation and empty-message errors.

### Task 1: Forward thinking effort for custom API models

**Files:** Modify `api/services/llm-runtime/thinking-mode-strategy.ts`; test `api/services/llm-runtime/__tests__/thinking-mode-strategy.test.ts`.

**Interfaces:** Consumes `ResolvedModelSelection` and `LlmGatewayRequest.reasoningEffort`; produces provider options under `selection.providerId` for OpenAI-compatible reasoning models.

- [ ] **Step 1: Add failing tests.** Use a `custom-api:glm` selection with `npm: '@ai-sdk/openai-compatible'`, `modelDef.reasoning: true`, and `apiFormat: 'openai'`. Assert `buildThinkingStreamOptions(selection, { reasoningEffort: 'high' }).providerOptions?.['custom-api:glm']` equals `{ reasoning_effort: 'high' }`; assert non-reasoning models retain existing options and no `thinking: { type: 'disabled' }` is sent.

```ts
expect(buildThinkingStreamOptions(customGlmSelection, { reasoningEffort: "high" })
  .providerOptions?.["custom-api:glm"]).toEqual({ reasoning_effort: "high" });
```
- [ ] **Step 2: Run the tests and confirm a red failure.** `npx vitest run api/services/llm-runtime/__tests__/thinking-mode-strategy.test.ts`.
- [ ] **Step 3: Implement minimally.** Extend the reasoning-capable strategy match to `@ai-sdk/openai-compatible` when `ctx.reasoning`; keep the existing DeepSeek precedence. In `buildStreamOptions`, pass explicit effort through `buildOpenAICompatibleProviderOptions(resolveProviderOptionsNamespace(selection), { reasoning_effort: effort })`, without sending fields when effort is absent.

```ts
if (ctx.reasoning && ctx.npm === "@ai-sdk/openai-compatible" && effort)
  return { providerOptions: buildOpenAICompatibleProviderOptions(
    resolveProviderOptionsNamespace(selection), { reasoning_effort: effort }) };
```

- [ ] **Step 4: Run the same tests and `npm run typecheck`; inspect `git diff` for unrelated changes.** Commit only this task's hunks, e.g. `git add api/services/llm-runtime/thinking-mode-strategy.ts api/services/llm-runtime/__tests__/thinking-mode-strategy.test.ts && git commit -m "fix(llm): forward custom model reasoning effort"`.

### Task 2: Collect bounded, read-only Git context

**Files:** Create `api/services/agent-runtime/session-commit-message-context.ts`; test `api/services/agent-runtime/__tests__/session-commit-message-context.test.ts`. Consult `session-environment.ts`, `session-git-commit.ts` and `session-workspace-git.test.ts` for repository and fixture rules.

**Interfaces:** Produce `collectCommitMessageContext(sessionId: string, rootId?: string): Promise<CommitMessageContext>` with the file-map fields; no mutations. If needed extract the existing root/top-level check into a shared small helper, not a second weaker validation path.

- [ ] **Step 1: Write fixture tests.** Initialize disposable Git repositories, add varied subjects (e.g. `fix(ui): 修复按钮`, `feat(api): add endpoint`), make staged + unstaged edits and an untracked file; snapshot `.git/index`, `HEAD`, and status before/after collection. Assert only the selected root's subjects, branch and changes are used, at most 20 subjects, and empty history is accepted. Add a large/binary fixture that proves the prompt input is bounded.

```ts
const before = repositoryState(primary);
const context = await collectCommitMessageContext(sessionId, primary.id);
expect(context.subjects.length).toBeLessThanOrEqual(20);
expect(context.diffExcerpt.length).toBeLessThanOrEqual(8_000);
expect(repositoryState(primary)).toEqual(before);
```
- [ ] **Step 2: Verify the tests fail.** `npx vitest run api/services/agent-runtime/__tests__/session-commit-message-context.test.ts`.
- [ ] **Step 3: Implement collection using this bounded read-only command helper:**

```ts
const result = await runCommand("git", args, { cwd: root.path,
  maxBufferBytes: 8 * 1024 * 1024, timeoutMs: 30_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
```

Resolve selected root using `resolveSessionRepository(..., true)`, validate actual Git top-level and branch, read `status --porcelain=v1 -uall`, `diff --cached --stat`, `diff --stat`, bounded `diff` plus `diff --cached`, and `log -20 --format=%s`. Permit `log` failure only for an unborn branch; throw for other Git errors. Cap statuses and diff excerpt, and document that untracked content is represented by filenames only. Never stage.
- [ ] **Step 4: Run fixture tests and `npm run typecheck`; commit only the two new files (and shared helper if extracted).** `git add api/services/agent-runtime/session-commit-message-context.ts api/services/agent-runtime/__tests__/session-commit-message-context.test.ts && git commit -m "feat(git): collect read-only commit context and history"` (stage a separately extracted helper explicitly if needed).

### Task 3: Stream model output and expose dedicated SSE endpoint

**Files:** Create `api/services/agent-runtime/session-commit-message-stream.ts`; modify `api/routes/agent-runtime.ts`; test `api/services/agent-runtime/__tests__/session-commit-message-stream.test.ts` and `api/routes/__tests__/agent-runtime-routes.test.ts` (or a dedicated route test file).

**Interfaces:** Consume `collectCommitMessageContext`, `resolveGatewaySelection` and `createGatewayStreamForSelection`. Produce `CommitMessageEvent` plus `POST /sessions/:sessionId/git/commit-message/stream` with JSON `{ rootId?: string, model: string }`. SSE `data` envelopes: `{ type: "delta", text }`, `{ type: "final", message }`, `{ type: "error", error }`, ending with `[DONE]` only after final or error.

- [ ] **Step 1: Add failing service and route tests.** Mock gateway stream with `text-delta`, `finish` and `error` events. Assert explicit selected model, `purpose: 'commit-message'`, `reasoningEffort: 'high'`, `maxTokens: 4096`, history subjects and bounded diff in prompt, only visible text deltas, normalized final message, empty output error, error propagation and signal abort. Verify auxiliary usage finishes once in success/error/abort. Route tests assert 400 for missing model, stream frames for success/error, and no Git commit commands.

```ts
expect(gatewayRequest).toMatchObject({ model: "custom-api:glm/glm-5.3-flash",
  purpose: "commit-message", reasoningEffort: "high", maxTokens: 4096 });
expect(events).toEqual([{ type: "delta", text: "fix:" },
  { type: "final", message: "fix: adjust dialog" }]);
```
- [ ] **Step 2: Run focused tests, confirm red.** `npx vitest run api/services/agent-runtime/__tests__/session-commit-message-stream.test.ts api/routes/__tests__/agent-runtime-routes.test.ts`.
- [ ] **Step 3: Implement stream service.** In `prepareCommitMessageGeneration`, reject active runs, collect context, resolve and validate the exact API model before SSE. Build a prompt where history and diff are labelled untrusted examples. In `streamSessionCommitMessage`, call `createGatewayStreamForSelection` with the prepared selection and request below. Accumulate visible text with a bounded maximum, yield deltas, then yield a normalized nonempty `final`; finish aux usage in `finally` (with usage from `finish` when available). Propagate abort without logging it as a warning.

```ts
const request = { projectId: context.projectId, purpose: "commit-message",
  model: input.model, reasoningEffort: "high" as const, maxTokens: 4096,
  messages: [{ role: "user" as const, content: buildCommitPrompt(context) }] };
const result = await createGatewayStreamForSelection(request, selection, signal);
for await (const part of result.fullStream) {
  if (part.type === "text-delta") yield { type: "delta", text: part.text };
  if (part.type === "error") throw part.error;
}
```
- [ ] **Step 4: Add the route.** Validate input with Zod and await `prepareCommitMessageGeneration` before opening SSE, so validation uses `runtimeError(c, error)`. Inside `streamSSE(c, async stream => ...)`, iterate `streamSessionCommitMessage(prepared, c.req.raw.signal)`, emit JSON envelopes, catch failures and send an error frame unless aborted, then close appropriately.

```ts
const prepared = await prepareCommitMessageGeneration(sessionId, parsed.data);
return streamSSE(c, async (stream) => {
  try {
    for await (const event of streamSessionCommitMessage(prepared, c.req.raw.signal))
      await stream.writeSSE({ data: JSON.stringify(event) });
  } catch (error) {
    if (!c.req.raw.signal.aborted)
      await stream.writeSSE({ data: JSON.stringify({ type: "error", error: String(error) }) });
  } finally {
    if (!c.req.raw.signal.aborted) await stream.writeSSE({ data: "[DONE]" });
  }
});
```
- [ ] **Step 5: Rerun focused tests and `npm run typecheck`, then commit only these files with `git add -p` for the shared routes file.** Commit message: `feat(git): stream history-aware commit messages`.

### Task 4: Make commit submission explicitly message-only

**Files:** Modify `api/services/agent-runtime/session-git-commit.ts`, `api/routes/agent-runtime.ts`; test `api/services/agent-runtime/__tests__/session-workspace-git.test.ts`, `api/services/agent-runtime/__tests__/session-git-commit.test.ts`, route tests.

**Interfaces:** Existing `commitSessionWorkspace(sessionId, { rootId?, message, push? })` returns the existing result; `messageGenerated` remains `false` for compatibility. Empty or normalized-empty `message` produces `GIT_COMMIT_MESSAGE_MISSING`/422 without staging. The route schema requires `message: z.string().min(1).max(2000)`; normalization still rejects whitespace-only.

- [ ] **Step 1: Write failing tests.** Call `commitSessionWorkspace(sessionId, { message: '', push: false })`; assert 422-equivalent error, no index/HEAD change, no gateway call. Add valid hand-written message and push-failure regression. Route test empty/missing/whitespace payloads and verify preexisting valid payload succeeds.

```ts
await expect(commitSessionWorkspace(sessionId, { message: "   ", push: false }))
  .rejects.toMatchObject({ code: "GIT_COMMIT_MESSAGE_MISSING" });
expect(repositoryState(primary)).toEqual(before);
```
- [ ] **Step 2: Run red.** `npx vitest run api/services/agent-runtime/__tests__/session-workspace-git.test.ts api/services/agent-runtime/__tests__/session-git-commit.test.ts api/routes/__tests__/agent-runtime-routes.test.ts`.
- [ ] **Step 3: Move normalized message validation before `git add -A`; remove `generateCommitMessage` and obsolete model-selection code/imports, retaining the exported normalizer for Task 3.** Verify `rg 'commitSessionWorkspace\(' api web/src` has no other implicit-generation caller; update route schema and comments. Do not change push semantics.

```ts
const message = normalizeCommitMessage(input.message ?? "");
if (!message) throw new AgentRuntimeError(
  "Enter a commit message or generate one first.", "GIT_COMMIT_MESSAGE_MISSING", 422);
// Only after this guard: await runGit(workspacePath, ["add", "-A"]);
```

- [ ] **Step 4: Rerun focused tests plus `npm run typecheck`; stage only task hunks and commit.** `git add -p api/services/agent-runtime/session-git-commit.ts api/routes/agent-runtime.ts && git commit -m "fix(git): require reviewed commit message"`.

### Task 5: Client streaming API and project-scoped model selection

**Files:** Modify `web/src/lib/api/agentRuntime.ts`; create `web/src/react/features/agent-workspace/commitMessageModelPreference.ts`; tests `web/src/lib/api/__tests__/commitMessageStream.test.ts` and `web/src/react/features/agent-workspace/__tests__/commitMessageModelPreference.test.ts`.

**Interfaces:** `agentRuntimeApi.streamCommitMessage(sessionId, { rootId?, model }, onEvent, signal): Promise<void>` receives the exact Task 3 SSE envelopes and rejects on `{ type: 'error' }`, malformed/truncated streams, or HTTP failures. `pickCommitMessageModel(models: AgentModelSelection[], sessionModel: string | null, rememberedModel: string | null): AgentModelSelection | null` and a project-keyed persisted `rememberCommitMessageModel(projectId, modelRef)` provide preferences.

- [ ] **Step 1: Add failing tests.** Feed SSE chunks split across JSON/line boundaries, assert ordered deltas and final, error frame and network error, abort preservation, missing `[DONE]` rejection. For model selection assert remembered configured API model wins; unavailable remembered model falls back to session model, then first API model; ACP never wins; project keys do not collide.

```ts
expect(pickCommitMessageModel(apiModels, sessionModel, remembered))
  .toMatchObject({ kind: "api", providerId: "custom-api:glm" });
expect(events.map(e => e.type)).toEqual(["delta", "final"]);
```
- [ ] **Step 2: Run red.** `npm run --prefix web test -- src/lib/api/__tests__/commitMessageStream.test.ts src/react/features/agent-workspace/__tests__/commitMessageModelPreference.test.ts`.
- [ ] **Step 3: Implement typed parser and API request with `apiFetch` from `web/src/lib/api/origin.ts`, response-body reader, `TextDecoder` streaming and `AbortSignal`.** Parse complete SSE frames rather than assuming one frame per network read; distinguish error/abort/normal completion and require a final event. Use a focused Zustand persist store or equivalent existing persistence pattern; write only the selected model reference under `projectId`, not Git history.

```ts
if (!response.ok || !response.body) throw await readStreamError(response);
// Decode incrementally; only dispatch an envelope after its blank-line SSE terminator.
if (event.type === "delta") onEvent(event);
else if (event.type === "final") { sawFinal = true; onEvent(event); }
else if (event.type === "error") throw new Error(event.error);
if (!sawFinal || !sawDone) throw new Error("Incomplete commit message stream");
```

- [ ] **Step 4: Run tests and `npm run --prefix web build`.** Because `agentRuntime.ts` already has unrelated edits, stage only matching hunks (`git add -p`) plus new files; commit as `feat(ui): add commit message stream client and model preference`.

### Task 6: HeroUI dialog interaction and full regression

**Files:** Modify `web/src/react/features/agent-workspace/SessionCommitDialog.tsx`, `WorkspaceDashboard.tsx`, `web/src/lib/i18n.ts`; test `web/src/react/features/agent-workspace/__tests__/SessionCommitDialog.test.tsx`. Use `useConfig(projectId)` and `buildAgentModelOptions(globalConfig, providers).apiModels`; for session model use `sessionRuntimeSelection` with the session/runs/steps from `useAgentSessionStore`.

**Interfaces:** `SessionCommitDialog` receives `projectId: string` in addition to existing props; its selected model is formatted with `formatModelReference(providerId, modelId)` and sent only to Task 5's stream API. Submit always sends an explicit `message`.

- [ ] **Step 1: Replace old implicit-generation tests with failing interaction tests.** Assert HeroUI `Button isIconOnly` star has accessible localised name and a model picker; first default is session model, switching persists per project. Mock callback deltas to see editor text grow, then final normalization. Test regeneration replaces text, failed/aborted generation restores the snapshot, closure and root/session switch invalidate late callbacks, empty submit shows an alert and never calls submit API, valid edited text commits as before. Ensure other existing dialog tests still pass.

```tsx
fireEvent.click(screen.getByRole("button", { name: "生成提交信息" }));
expect(screen.getByLabelText("提交信息")).toHaveValue("fix: new message");
expect(commitSessionWorkspace).not.toHaveBeenCalled();
```
- [ ] **Step 2: Run red.** `npm run --prefix web test -- src/react/features/agent-workspace/__tests__/SessionCommitDialog.test.tsx`.
- [ ] **Step 3: Implement focused UI.** Pass project ID from dashboard; use HeroUI `Button isIconOnly` with existing `Sparkles`, localized `aria-label`/tooltip, `isPending` while streaming and a cancel action. Place it inside the editor container without overlaying text or scrollbars. Snapshot previous value; abort + invalidate a request generation counter on close/root/session/model changes; coalesce incoming deltas per animation frame; temporarily disable editor and both submit buttons while streaming. On final replace with canonical one-line message; on failure restore snapshot. Keep existing success/push handling.

```tsx
<Button isIconOnly aria-label={t("workspaceCommitGenerate")}
  isPending={generating} onPress={generate} isDisabled={!selectedModel}>
  <Sparkles size={14} />
</Button>
// The cancel control aborts controller.current; completion checks requestId.
```

- [ ] **Step 4: Add matching Chinese and English copy.** Update placeholder/hint to remove “empty auto-generates”; label generate/cancel/model/empty input/error. Run focused tests, `npm run --prefix web build`, `npm run typecheck`, and server suites from Tasks 1–4. Inspect keyboard focus, tooltip, narrow dialog layout and stale-response behavior manually (no real commit).
- [ ] **Step 5: Stage only the intended hunks (`git add -p` where files overlap preexisting work) and commit as `feat(ui): explicitly generate and review commit messages`.** Compare `git status --short` against the starting state to confirm all unrelated modifications remain.

## Final acceptance checklist

- [ ] User-selected model receives an active thinking request; GLM-compatible provider namespace contains the chosen effort, with enough tokens left for a visible message.
- [ ] Generation is triggered only by the star and returns only current-root context plus at most 20 current-branch subjects; no Git side effects.
- [ ] Stream writes visible text incrementally, replaces prior content on regeneration, restores it on failure/abort, and discards stale chunks.
- [ ] Empty submit never generates; valid manual or edited message still commits/pushes with prior semantics.
- [ ] All focused Vitest suites, root `npm run typecheck`, and `npm run --prefix web build` pass; unrelated worktree changes are untouched.
