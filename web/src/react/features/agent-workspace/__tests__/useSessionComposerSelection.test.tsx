import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentRun } from "../../../../lib/api/agentRuntime";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useAgentDockStore } from "../state/agentDockStore";
import {
  useSessionComposerSelection,
  useSessionComposerSelections,
} from "../useSessionComposerSelection";
import { sessionRuntimeSelection } from "../sessionRuntimeSelection";

vi.mock("../../../../lib/api/runtimeEventBus", () => ({
  subscribe: () => vi.fn(),
}));
vi.mock("../../../../lib/api/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
}));
const a = {
  id: "a",
  projectId: "p",
  model: "model-a",
  reasoningEffort: "low",
  sessionMetadata: {},
} as AgentSession;
const b = {
  ...a,
  id: "b",
  model: "model-b",
  reasoningEffort: "high",
} as AgentSession;

beforeEach(() => {
  useSessionComposerSelections.setState({
    selections: {},
    lastSubmittedByProject: {},
  });
  useAgentSessionStore.setState({ ...useAgentSessionStore.getInitialState() });
  useAgentDockStore.setState({
    composerProviderId: "api",
    composerModelId: "draft",
    composerReasoningEffort: "high",
  });
});

describe("session composer selection", () => {
  it("restores a qualified API model without switching provider or duplicating its prefix", () => {
    const providerId = "custom-api:kiro-local";
    const providers = [
      {
        id: providerId,
        label: "Kiro",
        status: "live" as const,
        kind: "api" as const,
        caps: { canFollowUp: true, canCancel: true },
        models: [{ id: "claude-opus-5", label: "Opus 5", isDefault: true }],
      },
    ];
    const session = { ...a, model: `${providerId}/claude-opus-5` };
    const hook = renderHook(() =>
      useSessionComposerSelection(
        "p",
        session,
        "native",
        null,
        providers,
        null,
      ),
    );
    expect(hook.result.current).toMatchObject({
      providerId,
      modelId: "claude-opus-5",
    });
  });

  it.each(["native", "codex", "codex-acp"] as const)(
    "restores independent unsent choices after switching and remounting: %s",
    (backend) => {
      const hook = renderHook(
        ({ session }) =>
          useSessionComposerSelection("p", session, backend, null, [], null),
        { initialProps: { session: a } },
      );
      expect(hook.result.current.modelId).toBe("model-a");
      act(() =>
        hook.result.current.setSelection({
          providerId: "chosen",
          modelId: "next-a",
          cliModel: "cli-a",
          reasoningEffort: "xhigh",
        }),
      );
      hook.rerender({ session: b });
      expect(hook.result.current.modelId).toBe("model-b");
      expect(hook.result.current.reasoningEffort).toBe("high");
      act(() =>
        hook.result.current.setSelection({
          modelId: "next-b",
          cliModel: "cli-b",
          reasoningEffort: "medium",
        }),
      );
      hook.rerender({ session: a });
      expect(hook.result.current).toMatchObject({
        providerId: "chosen",
        modelId: "next-a",
        cliModel: "cli-a",
        reasoningEffort: "xhigh",
      });
      hook.unmount();
      const restored = renderHook(() =>
        useSessionComposerSelection("p", a, backend, null, [], null),
      );
      expect(restored.result.current).toMatchObject({
        modelId: "next-a",
        cliModel: "cli-a",
        reasoningEffort: "xhigh",
      });
    },
  );

  it("keeps live execution independent from edits and retains choices when runtime refreshes", () => {
    const run = {
      id: "run",
      sessionId: "a",
      model: "running-model",
      startedAt: "2026-01-01",
      metadata: { reasoningEffort: "medium" },
    } as AgentRun;
    useAgentSessionStore.setState({ selectedSessionId: "a", runs: [run] });
    const hook = renderHook(() =>
      useSessionComposerSelection("p", a, "native", null, [], null),
    );
    expect(hook.result.current).toMatchObject({
      modelId: "running-model",
      reasoningEffort: "medium",
    });
    act(() =>
      hook.result.current.setSelection({
        modelId: "future-model",
        reasoningEffort: "xhigh",
      }),
    );
    expect(sessionRuntimeSelection(a, [run], [])).toEqual({
      model: "running-model",
      reasoningEffort: "medium",
    });
    act(() =>
      useAgentSessionStore.setState({
        runs: [{ ...run, model: "updated-runtime" }],
      }),
    );
    expect(hook.result.current).toMatchObject({
      modelId: "future-model",
      reasoningEffort: "xhigh",
    });
    expect(useAgentDockStore.getState().composerModelId).toBe("draft");
  });

  it.each(["native", "codex", "codex-acp"] as const)(
    "uses the last submitted selection as the next-session default: %s",
    (backend) => {
      const hook = renderHook(() =>
        useSessionComposerSelection("p", undefined, backend, null, [], null),
      );
      act(() =>
        hook.result.current.setSelection({
          providerId: backend === "native" ? "api" : backend,
          modelId: "last-model",
          cliModel: "last-cli-model",
          reasoningEffort: "xhigh",
        }),
      );
      act(() => hook.result.current.markSubmitted("created-session"));

      const remembered = useSessionComposerSelections.getState();
      expect(remembered.lastSubmittedByProject.p).toMatchObject({
        backendId: backend,
        modelId: "last-model",
        cliModel: "last-cli-model",
        reasoningEffort: "xhigh",
      });

      // A fresh mount must be able to initialize from the submitted value,
      // independently of the transient draft entry.
      act(() => useSessionComposerSelections.setState({ selections: {} }));
      hook.unmount();
      const next = renderHook(() =>
        useSessionComposerSelection("p", undefined, backend, null, [], null),
      );
      expect(next.result.current).toMatchObject({
        modelId: "last-model",
        cliModel: "last-cli-model",
        reasoningEffort: "xhigh",
      });
    },
  );

  it("does not apply a submitted model to a different project or backend", () => {
    const submitted = {
      providerId: "codex-acp",
      modelId: "gpt-last",
      cliModel: "default",
      reasoningEffort: "high" as const,
    };
    act(() =>
      useSessionComposerSelections
        .getState()
        .rememberSubmission("p", "s", "codex-acp", submitted),
    );

    const otherBackend = renderHook(() =>
      useSessionComposerSelection("p", undefined, "native", null, [], null),
    );
    expect(otherBackend.result.current.modelId).toBe("draft");
    const otherProject = renderHook(() =>
      useSessionComposerSelection(
        "other",
        undefined,
        "codex-acp",
        null,
        [],
        null,
      ),
    );
    expect(otherProject.result.current.modelId).toBe("default");
  });

  it("preserves unknown runtime effort and ignores other sessions", () => {
    const run = {
      id: "run",
      sessionId: "a",
      model: "actual",
      startedAt: "2026-01-01",
      metadata: { reasoningEffort: null },
    } as AgentRun;
    expect(
      sessionRuntimeSelection(
        a,
        [run, { ...run, sessionId: "b", model: "wrong", startedAt: "2027" }],
        [],
      ),
    ).toEqual({ model: "actual", reasoningEffort: null });
  });
});
