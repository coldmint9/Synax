// @vitest-environment jsdom
import { useState, type ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentComposer } from "../AgentComposer";
import {
  clearComposerHistory,
  composerHistoryScope,
  recordComposerInput,
} from "../composerInputHistory";

vi.mock("../../../../../lib/api/origin", () => ({
  apiRequest: vi.fn(() => Promise.resolve({})),
}));
vi.mock("@/react/features/media/useInputCapability", () => ({
  useInputCapability: () => ({ blocked: false, error: false, loading: false }),
}));

const noop = () => {};
const base: ComponentProps<typeof AgentComposer> = {
  projectId: "project-a",
  sessionId: "session-1",
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
  clearOnSubmit = false,
  ...overrides
}: Partial<typeof base> & { initial?: string; clearOnSubmit?: boolean }) {
  const [content, setContent] = useState(initial);
  return (
    <AgentComposer
      {...base}
      {...overrides}
      content={content}
      onContentChange={setContent}
      onSubmit={clearOnSubmit ? () => setContent("") : noop}
    />
  );
}

const editor = () => screen.getByRole<HTMLTextAreaElement>("textbox");
const scope = composerHistoryScope("project-a", "session-1");

beforeEach(() => clearComposerHistory());

describe("composer input history recall", () => {
  it("walks to older entries with ArrowUp and stops at the oldest", async () => {
    const user = userEvent.setup();
    recordComposerInput(scope, "first");
    recordComposerInput(scope, "second");
    recordComposerInput(scope, "third");
    render(<Editor initial="draft" />);
    const input = editor();
    await user.click(input);
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveValue("third");
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveValue("second");
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveValue("first");
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveValue("first");
  });

  it("walks back with ArrowDown and restores the unsent draft", async () => {
    const user = userEvent.setup();
    recordComposerInput(scope, "first");
    recordComposerInput(scope, "second");
    render(<Editor initial="draft" />);
    const input = editor();
    await user.click(input);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(input).toHaveValue("first");
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveValue("second");
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveValue("draft");
  });

  it("leaves the draft alone while there is no history", async () => {
    const user = userEvent.setup();
    render(<Editor initial="draft" />);
    const input = editor();
    await user.click(input);
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveValue("draft");
  });

  it("keeps native caret movement inside a multiline draft", async () => {
    recordComposerInput(scope, "recalled");
    render(<Editor initial={"first line\nsecond line"} />);
    const input = editor();
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveValue("first line\nsecond line");
  });

  it("starts over from the newest entry once the user edits the text", async () => {
    const user = userEvent.setup();
    recordComposerInput(scope, "one");
    recordComposerInput(scope, "two");
    render(<Editor initial="draft" />);
    const input = editor();
    await user.click(input);
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveValue("two");
    await user.keyboard("!");
    expect(input).toHaveValue("two!");
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveValue("two!");
  });

  it("records what was submitted and ignores repeats of the newest entry", async () => {
    const user = userEvent.setup();
    render(<Editor clearOnSubmit />);
    const input = editor();
    await user.type(input, "hello");
    await user.keyboard("{Enter}");
    expect(input).toHaveValue("");
    await user.type(input, "hello");
    await user.keyboard("{Enter}");
    expect(input).toHaveValue("");
    expect(composerHistoryScope("project-a", "session-1")).toBe(scope);
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveValue("hello");
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveValue("hello");
  });

  it("keeps histories apart per session", async () => {
    const user = userEvent.setup();
    recordComposerInput(
      composerHistoryScope("project-a", "session-2"),
      "elsewhere",
    );
    render(<Editor initial="draft" />);
    const input = editor();
    await user.click(input);
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveValue("draft");
  });
});
