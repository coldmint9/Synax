// @vitest-environment jsdom
import { useState, type ComponentProps } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentComposer } from "../AgentComposer";
import { useTabKeyBehavior } from "../../../../shared/hooks/useTabKeyBehavior";
import type { SessionLifecycleSnapshot } from "../../state/sessionLifecycle";

const mocks = vi.hoisted(() => ({
  suggest: vi.fn(),
  optimize: vi.fn(),
}));
vi.mock("../../../../adapters/transport/inputSuggestion", () => ({
  suggestNextInput: mocks.suggest,
}));
vi.mock("../../../../adapters/transport/inputOptimization", () => ({
  optimizeInput: mocks.optimize,
}));

const noop = () => {};
const props: ComponentProps<typeof AgentComposer> = {
  projectId: "p1",
  sessionId: "s1",
  content: "",
  onContentChange: noop,
  onSubmit: noop,
  providerId: "provider",
  modelId: "model",
  onModelSelect: noop,
  providers: [],
  globalConfig: null,
  skillIds: [],
  onSkillIdsChange: noop,
  subagentsEnabled: false,
  onSubagentsEnabledChange: noop,
  reasoningEffort: "high",
  onReasoningEffortChange: noop,
  permissionTier: "boundary",
  onPermissionTierChange: noop,
  modeControl: <span>Chat</span>,
};

const activity = (
  overrides: Partial<SessionLifecycleSnapshot> = {},
): SessionLifecycleSnapshot => ({
  activeTurn: true,
  stepId: "step-1",
  hasReplyText: false,
  hasToolCall: false,
  ...overrides,
});

function Composer({
  snapshot,
  locked = false,
}: {
  snapshot: SessionLifecycleSnapshot;
  locked?: boolean;
}) {
  const [content, setContent] = useState("");
  // The app installs the global Tab handler; the composer must still win.
  useTabKeyBehavior();
  return (
    <AgentComposer
      {...props}
      content={content}
      onContentChange={setContent}
      disabled={locked}
      replyActivity={{ snapshot, text: "已经改好了" }}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.suggest.mockResolvedValue("运行测试");
});

it("pre-fills the empty composer after the turn and accepts the guess on Tab", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Composer snapshot={activity()} locked />);
  expect(mocks.suggest).not.toHaveBeenCalled();

  // The reply phase starts while the turn still owns the composer.
  act(() =>
    rerender(<Composer snapshot={activity({ hasReplyText: true })} locked />),
  );
  expect(mocks.suggest).toHaveBeenCalledTimes(1);
  await act(async () => {});
  expect(screen.queryByText("运行测试")).toBe(null);

  rerender(<Composer snapshot={activity({ activeTurn: false })} />);
  expect(screen.getByText("运行测试")).toBeTruthy();
  expect(screen.getByRole("textbox")).toHaveValue("");

  await user.click(screen.getByRole("textbox"));
  await user.keyboard("{Tab}");

  expect(screen.getByRole("textbox")).toHaveValue("运行测试");
  expect(screen.queryByText("运行测试", { selector: ".composer-suggestion-text" })).toBe(null);
});

it("shows no pre-fill once the user is writing", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Composer snapshot={activity()} locked />);
  act(() =>
    rerender(<Composer snapshot={activity({ hasReplyText: true })} locked />),
  );
  await act(async () => {});
  rerender(<Composer snapshot={activity({ activeTurn: false })} />);
  expect(screen.getByText("运行测试")).toBeTruthy();

  await user.type(screen.getByRole("textbox"), "我");

  expect(screen.queryByText("运行测试", { selector: ".composer-suggestion-text" })).toBe(null);
});
