// @vitest-environment jsdom
import { useState, type ComponentProps } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentComposer } from "../AgentComposer";

const noop = () => {};
const props: ComponentProps<typeof AgentComposer> = {
  projectId: "project-a",
  content: "",
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
  modelControl: <span>Model</span>,
};
function Editor({
  initial = "",
  ...overrides
}: Partial<typeof props> & { initial?: string }) {
  const [content, setContent] = useState(initial);
  return (
    <AgentComposer
      {...props}
      {...overrides}
      content={content}
      onContentChange={setContent}
    />
  );
}
const editor = () => screen.getByRole<HTMLTextAreaElement>("textbox");
afterEach(() => vi.restoreAllMocks());

describe("composer editor identity across compact and expanded layouts", () => {
  it("keeps typing into the exact same editor after Shift+Enter and after deleting the newline", async () => {
    const user = userEvent.setup();
    const submit = vi.fn();
    const { container } = render(<Editor onSubmit={submit} />);
    const input = editor();
    await user.type(input, "Draft");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(editor()).toBe(input);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Draft\n");
    expect(input.selectionStart).toBe(6);
    expect(input.selectionEnd).toBe(6);
    expect(container.querySelector(".agent-dock-composer")).toHaveAttribute(
      "data-multiline",
      "true",
    );
    await user.keyboard("x");
    expect(input).toHaveValue("Draft\nx");
    input.setSelectionRange(5, 6);
    await user.keyboard("{Backspace}");
    expect(editor()).toBe(input);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Draftx");
    expect(input.selectionStart).toBe(5);
    expect(input.selectionEnd).toBe(5);
    expect(container.querySelector(".agent-dock-composer")).not.toHaveAttribute(
      "data-multiline",
    );
    await user.keyboard("y");
    expect(input).toHaveValue("Draftyx");
    expect(submit).not.toHaveBeenCalled();
  });

  it("preserves a backwards selection through explicit expand and compact toggles", async () => {
    const user = userEvent.setup();
    const view = render(<Editor initial="Draft" />);
    const input = editor();
    await user.click(input);
    input.setSelectionRange(1, 4, "backward");
    view.rerender(<Editor initial="Draft" defaultExpanded />);
    expect(editor()).toBe(input);
    expect(input).toHaveFocus();
    expect([
      input.selectionStart,
      input.selectionEnd,
      input.selectionDirection,
    ]).toEqual([1, 4, "backward"]);
    view.rerender(<Editor initial="Draft" />);
    expect(editor()).toBe(input);
    expect(input).toHaveFocus();
    expect([
      input.selectionStart,
      input.selectionEnd,
      input.selectionDirection,
    ]).toEqual([1, 4, "backward"]);
    await user.keyboard("x");
    expect(input).toHaveValue("Dxt");
  });

  it("does not refocus the editor when a draft expands or contracts while focus is elsewhere", () => {
    const view = render(
      <>
        <AgentComposer {...props} content="Draft" />
        <button>Elsewhere</button>
      </>,
    );
    const input = editor();
    const outside = screen.getByRole("button", { name: "Elsewhere" });
    outside.focus();
    const focus = vi.spyOn(input, "focus");
    for (const content of ["Draft\nx", "Draft"]) {
      view.rerender(
        <>
          <AgentComposer {...props} content={content} />
          <button>Elsewhere</button>
        </>,
      );
      expect(editor()).toBe(input);
      expect(outside).toHaveFocus();
    }
    expect(focus).not.toHaveBeenCalled();
  });

  it("keeps the composing editor alive across both layouts and suppresses IME commit Enter", () => {
    const submit = vi.fn();
    render(<Editor onSubmit={submit} />);
    const input = editor();
    input.focus();
    fireEvent.compositionStart(input);
    for (const content of ["输入\n中", "输入中"]) {
      fireEvent.change(input, { target: { value: content } });
      expect(editor()).toBe(input);
      expect(input).toHaveFocus();
      expect(input).toHaveValue(content);
      fireEvent.keyDown(input, { key: "Enter" });
    }
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps the inline editor focused when switching to a multiline session draft and back", async () => {
    const user = userEvent.setup();
    const changeA = vi.fn(),
      changeB = vi.fn();
    const view = render(
      <AgentComposer
        {...props}
        sessionId="a"
        content="Draft A"
        onContentChange={changeA}
      />,
    );
    const input = editor();
    await user.click(input);
    view.rerender(
      <AgentComposer
        {...props}
        sessionId="b"
        content={"Draft B\n"}
        onContentChange={changeB}
      />,
    );
    expect(editor()).toBe(input);
    expect(input).toHaveFocus();
    input.setSelectionRange(8, 8);
    await user.keyboard("x");
    expect(changeB).toHaveBeenLastCalledWith("Draft B\nx");
    view.rerender(
      <AgentComposer
        {...props}
        sessionId="a"
        content="Draft A"
        onContentChange={changeA}
      />,
    );
    expect(editor()).toBe(input);
    expect(input).toHaveFocus();
    input.setSelectionRange(7, 7);
    await user.keyboard("y");
    expect(changeA).toHaveBeenLastCalledWith("Draft Ay");
  });

  it("rejects a late IME commit from the old inline session after its layout changes", async () => {
    const changeB = vi.fn();
    const view = render(
      <AgentComposer {...props} sessionId="a" content="Draft A" />,
    );
    const input = editor();
    input.focus();
    fireEvent.compositionStart(input);
    view.rerender(
      <AgentComposer
        {...props}
        sessionId="b"
        content={"Draft B\n"}
        onContentChange={changeB}
      />,
    );
    expect(editor()).toBe(input);
    expect(input).not.toHaveFocus();
    fireEvent.compositionEnd(input);
    fireEvent.change(input, { target: { value: "旧会话输入" } });
    expect(changeB).not.toHaveBeenCalled();
    expect(input).toHaveValue("Draft B\n");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "新会话输入" } });
    expect(changeB).toHaveBeenCalledWith("新会话输入");
    fireEvent.compositionEnd(input);
  });
});
