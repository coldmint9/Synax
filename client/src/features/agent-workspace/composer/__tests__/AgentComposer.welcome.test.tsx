import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
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

describe("welcome composer visual hint", () => {
  it("keeps typed text and submit payload separate from the animation, and never replays on clear", async () => {
    const sent = vi.fn();
    function Editor() {
      const [content, setContent] = useState("");
      return (
        <AgentComposer
          {...props}
          content={content}
          defaultExpanded
          welcomePlaceholderDelay={0}
          placeholder="写下你的灵感…"
          onContentChange={setContent}
          onSubmit={() => sent(content)}
        />
      );
    }
    const user = userEvent.setup();
    const { container } = render(<Editor />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("");
    expect(input).not.toHaveAttribute("placeholder");
    await user.type(input, "这是实际草稿");
    expect(input).toHaveValue("这是实际草稿");
    expect(container.querySelector(".welcome-editor-hint")).toHaveAttribute(
      "hidden",
    );
    await user.keyboard("{Enter}");
    expect(sent).toHaveBeenCalledWith("这是实际草稿");
    await user.clear(input);
    expect(container.querySelector(".welcome-editor-hint")).not.toHaveAttribute(
      "hidden",
    );
    expect(
      container.querySelector("[data-welcome-typewriter]"),
    ).not.toHaveAttribute("data-typing");
  });

  it("preserves the ordinary placeholder for existing session editors", () => {
    const { container } = render(
      <AgentComposer {...props} content="" placeholder="普通输入提示" />,
    );
    expect(screen.getByRole("textbox")).toHaveAttribute(
      "placeholder",
      "普通输入提示",
    );
    expect(container.querySelector(".welcome-editor-hint")).toBeNull();
  });

  it("switches mode hints without changing the textarea value", () => {
    const { container, rerender } = render(
      <AgentComposer
        {...props}
        content=""
        defaultExpanded
        welcomePlaceholderDelay={0}
        placeholder="写下灵感"
      />,
    );
    rerender(
      <AgentComposer
        {...props}
        content=""
        defaultExpanded
        welcomePlaceholderDelay={0}
        placeholder="写下目标"
      />,
    );
    expect(container.querySelector(".welcome-editor-hint")).toHaveTextContent(
      "写下目标",
    );
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
});
