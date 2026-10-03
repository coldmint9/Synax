import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  wikiAttachMode: "auto",
  onWikiAttachModeChange: noop,
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

describe("real composer session switching", () => {
  it("retains the real textarea, focus, and approval control nodes", () => {
    const view = render(<AgentComposer {...props} />);
    const input = screen.getByRole("textbox");
    const approval = screen.getByRole("button", {
      name: /审批模式|Approval mode/,
    });
    input.focus();
    view.rerender(
      <AgentComposer
        {...props}
        sessionId="b"
        content={"Draft B\nSecond line"}
        permissionTier="unrestricted"
      />,
    );
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Draft B\nSecond line");
    expect(screen.getByRole("button", { name: /审批模式|Approval mode/ })).toBe(
      approval,
    );
    expect(approval).toHaveAttribute("data-tier", "unrestricted");
  });

  it("does not let a late approval error from A disable or display in B", async () => {
    let rejectA!: (error: Error) => void;
    const pending = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectA = reject;
        }),
    );
    const view = render(
      <AgentComposer {...props} onPermissionTierChange={pending} />,
    );
    const approval = screen.getByRole("button", {
      name: /审批模式|Approval mode/,
    });
    const user = userEvent.setup();
    await user.click(approval);
    await user.click(screen.getByRole("option", { name: /自动审批|Auto/ }));
    expect(approval).toBeDisabled();
    view.rerender(<AgentComposer {...props} sessionId="b" content="B" />);
    expect(screen.getByRole("button", { name: /审批模式|Approval mode/ })).toBe(
      approval,
    );
    expect(approval).not.toBeDisabled();
    await act(async () => rejectA(new Error("A failed")));
    expect(approval).not.toBeDisabled();
    expect(screen.queryByText("A failed")).not.toBeInTheDocument();
  });
});

it("does not write an old IME composition into the newly selected draft", () => {
  const changeA = vi.fn();
  const changeB = vi.fn();
  const view = render(<AgentComposer {...props} onContentChange={changeA} />);
  const input = screen.getByRole("textbox");
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: "输入中" } });
  expect(changeA).toHaveBeenCalledWith("输入中");
  view.rerender(
    <AgentComposer
      {...props}
      sessionId="b"
      content="B draft"
      onContentChange={changeB}
    />,
  );
  fireEvent.compositionEnd(input);
  fireEvent.change(input, { target: { value: "旧会话最终输入" } });
  expect(changeB).not.toHaveBeenCalled();
  expect(input).toHaveValue("B draft");
});
