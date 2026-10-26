import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentComposer } from "../AgentComposer";

const noop = () => {};
const props: ComponentProps<typeof AgentComposer> = {
  projectId: "p1",
  sessionId: "a",
  content: "Draft A",
  onContentChange: noop,
  onSubmit: noop,
  providerId: null,
  modelId: null,
  onModelSelect: noop,
  providers: [],
  globalConfig: null,
  documentId: null,
  onDocumentChange: noop,


  documents: [],
  skillIds: [],
  onSkillIdsChange: noop,
  reasoningEffort: "high",
  onReasoningEffortChange: noop,
  permissionTier: "boundary",
  onPermissionTierChange: noop,
  modeControl: <span>Chat</span>,
  modelControl: <span>Model</span>,
};

const mocks = vi.hoisted(() => ({ optimize: vi.fn() }));
vi.mock("../../../../adapters/transport/inputOptimization", () => ({
  optimizeInput: mocks.optimize,
}));
beforeEach(() => vi.clearAllMocks());

it.each([false, true])(
  "optimizes and undoes without sending (expanded=%s)",
  async (expanded) => {
    const submit = vi.fn();
    mocks.optimize.mockResolvedValue({ text: "整理后的需求" });
    function Composer() {
      const [content, setContent] = useState("帮我整理思路");
      return (
        <AgentComposer
          {...props}
          sessionId={undefined}
          modeControl={undefined}
          backendId={undefined}
          defaultExpanded={expanded}
          content={content}
          onContentChange={setContent}
          providerId="openai"
          modelId="current"
          onSubmit={submit}
        />
      );
    }
    render(<Composer />);
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", {
        name: /优化输入|Optimize input/,
      }),
    );
    expect(screen.getByRole("textbox")).toHaveValue("整理后的需求");
    expect(submit).not.toHaveBeenCalled();
    expect(mocks.optimize.mock.calls[0][0].model).toBe("openai/current");
    await user.click(
      screen.getByRole("button", { name: /撤销优化|Undo optimization/ }),
    );
    expect(screen.getByRole("textbox")).toHaveValue("帮我整理思路");
    expect(
      screen.queryByRole("button", { name: /撤销优化|Undo optimization/ }),
    ).not.toBeInTheDocument();
  },
);
it("disables optimization for empty and locked drafts and shows pending state", async () => {
  const view = render(<AgentComposer {...props} content="   " />);
  const button = () =>
    screen.getByRole("button", {
      name: /优化输入|Optimize input/,
    });
  expect(button()).toBeDisabled();
  view.rerender(<AgentComposer {...props} disabled />);
  expect(button()).toBeDisabled();
  let resolve!: (value: { text: string }) => void;
  mocks.optimize.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  view.rerender(<AgentComposer {...props} />);
  fireEvent.click(button());
  expect(button()).toBeDisabled();
  expect(button()).toHaveAttribute("aria-busy", "true");
  fireEvent.click(button());
  expect(mocks.optimize).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ text: "优化" }));
});
it.each([false, true])(
  "only shows a button spinner while waiting and applies the final rewrite once (expanded=%s)",
  async (expanded) => {
    const draft = "帮我检查下";
    const rewritten = "请帮我检查一下，指出存在的问题并给出改进建议。";
    const change = vi.fn();
    const submit = vi.fn();
    let complete!: (value: { text: string; status: string }) => void;
    let stream!: (text: string) => void;
    mocks.optimize.mockImplementation((_input, _signal, onDelta) => {
      stream = (text) => onDelta?.(text);
      return new Promise((resolve) => { complete = resolve; });
    });
    function Composer() {
      const [content, setContent] = useState(draft);
      return (
        <AgentComposer
          {...props}
          sessionId={expanded ? undefined : "a"}
          modeControl={expanded ? undefined : <span>Chat</span>}
          defaultExpanded={expanded}
          content={content}
          onContentChange={(text) => { change(text); setContent(text); }}
          onSubmit={submit}
        />
      );
    }
    render(<Composer />);
    const button = screen.getByRole("button", { name: /优化输入|Optimize input/ });
    fireEvent.click(button);
    act(() => stream("正在生成但还未验证的改写"));
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector(".animate-spin")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue(draft);
    expect(screen.queryByText(/正在优化输入|Optimizing input|正在生成但还未验证的改写/)).not.toBeInTheDocument();
    expect(change).not.toHaveBeenCalled();
    await act(async () => complete({ text: rewritten, status: "optimized" }));
    expect(screen.getByRole("textbox")).toHaveValue(rewritten);
    expect(change).toHaveBeenCalledExactlyOnceWith(rewritten);
    expect(submit).not.toHaveBeenCalled();
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "false");
    expect(button.querySelector(".animate-spin")).not.toBeInTheDocument();
  },
);
it("shows local errors while keeping the original textarea value", async () => {
  mocks.optimize.mockRejectedValue(new Error("请配置模型"));
  render(<AgentComposer {...props} />);
  await userEvent.click(
    screen.getByRole("button", {
      name: /优化输入|Optimize input/,
    }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("请配置模型");
  expect(screen.getByRole("textbox")).toHaveValue("Draft A");
});
it.each([false, true])(
  "renders composer text with a readable normal weight (expanded=%s)",
  (expanded) => {
    render(
      <AgentComposer
        {...props}
        sessionId={expanded ? undefined : "a"}
        modeControl={expanded ? undefined : <span>Chat</span>}
        defaultExpanded={expanded}
      />,
    );
    expect(screen.getByRole("textbox")).toHaveClass("font-normal");
  },
);
