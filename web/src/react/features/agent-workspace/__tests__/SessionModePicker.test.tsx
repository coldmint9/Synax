import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionModePicker } from "../SessionModePicker";
import { AgentComposer } from "../composer/AgentComposer";

vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../composer/ComposerAttachMenu", () => ({
  ComposerAttachMenu: () => <button>Attach</button>,
}));
vi.mock("../composer/ComposerPermissionPicker", () => ({
  ComposerPermissionPicker: () => <button>Permission</button>,
}));
vi.mock("../composer/ComposerModelPicker", () => ({
  ComposerModelPicker: () => <button>Model</button>,
}));
vi.mock("../composer/ComposerEffortPicker", () => ({
  ComposerEffortPicker: () => <button>Effort</button>,
}));

const props = {
  projectId: "p1",
  content: "",
  onContentChange: vi.fn(),
  onSubmit: vi.fn(),
  providerId: null,
  modelId: null,
  onModelSelect: vi.fn(),
  providers: [],
  globalConfig: null,
  documentId: null,
  onDocumentChange: vi.fn(),
  wikiAttachMode: "auto" as const,
  onWikiAttachModeChange: vi.fn(),
  documents: [],
  skillIds: [],
  onSkillIdsChange: vi.fn(),
  reasoningEffort: "high" as const,
  onReasoningEffortChange: vi.fn(),
  permissionTier: "boundary" as const,
  onPermissionTierChange: vi.fn(),
};

describe("compact session mode control", () => {
  it.each([false, true])(
    "shows newline and slash command hints (expanded=%s)",
    (expanded) => {
      render(
        <AgentComposer
          {...props}
          defaultExpanded={expanded}
          placeholder="Ask Synax…"
          commands={{
            inputRef: { current: null },
            onInput: vi.fn(),
            onKeyDown: () => false,
            header: null,
            trigger: null,
            open: false,
            listId: "commands",
          }}
        />,
      );
      expect(screen.getByRole("textbox")).toHaveAttribute(
        "placeholder",
        "Ask Synax… Shift+Enter for a new line · / for commands",
      );
    },
  );

  it("turns the stop action into a pulsing queue-send action only while new input is present", async () => {
    const onStop = vi.fn(),
      onSubmit = vi.fn();
    const view = render(
      <AgentComposer
        {...props}
        isGenerating
        queueWhileGenerating
        onStop={onStop}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByRole("button", { name: "agentStop" })).toBeEnabled();
    view.rerender(
      <AgentComposer
        {...props}
        content="Next task"
        isGenerating
        queueWhileGenerating
        onStop={onStop}
        onSubmit={onSubmit}
      />,
    );
    const send = screen.getByRole("button", { name: "inputQueueSend" });
    expect(send).toHaveAttribute("data-queue-ready", "true");
    expect(
      screen.queryByRole("button", { name: "agentStop" }),
    ).not.toBeInTheDocument();
    await userEvent.click(send);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();
    view.rerender(
      <AgentComposer
        {...props}
        content="  "
        isGenerating
        queueWhileGenerating
        onStop={onStop}
        onSubmit={onSubmit}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "agentStop" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("keeps the stop action when queuing is unavailable", () => {
    render(
      <AgentComposer
        {...props}
        content="Next task"
        isGenerating
        disabled
        onStop={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "agentStop" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "inputQueueSend" }),
    ).not.toBeInTheDocument();
  });
  it.each([false, true])(
    "keeps the optional control inside the shared composer (expanded=%s)",
    (expanded) => {
      const { container } = render(
        <AgentComposer
          {...props}
          defaultExpanded={expanded}
          modeControl={
            <SessionModePicker
              mode="chat"
              disabled={false}
              description="Mode does not change permissions."
              onChange={vi.fn()}
            />
          }
        />,
      );
      const control = screen.getByRole("button", { name: "Session mode" });
      expect(control.closest(".agent-dock-composer")).toBeTruthy();
      expect(
        control.compareDocumentPosition(
          screen.getByRole("button", { name: "Model" }),
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(container.querySelectorAll(".agent-mode-trigger")).toHaveLength(1);
    },
  );

  it("does not add session controls to other shared composer consumers", () => {
    render(<AgentComposer {...props} />);
    expect(
      screen.queryByRole("button", { name: "Session mode" }),
    ).not.toBeInTheDocument();
  });

  it("supports keyboard selection and returns focus to the trigger", async () => {
    const onChange = vi.fn(),
      user = userEvent.setup();
    render(
      <SessionModePicker
        mode="chat"
        disabled={false}
        description="Mode does not change permissions."
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Session mode" });
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByRole("listbox", { name: "Session mode" }),
    ).toBeVisible();
    // In a layout-less DOM the popover focuses its dialog first; Tab enters the list.
    await user.tab();
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /^Chat\b/ })).toHaveFocus(),
    );
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /^Plan\b/ })).toHaveFocus(),
    );
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("plan");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("cannot open the picker when the existing safety guard disables switching", async () => {
    const onChange = vi.fn();
    render(
      <SessionModePicker
        mode="goal"
        disabled
        description="Resolve the pending request first."
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Session mode" });
    expect(trigger).toBeDisabled();
    await userEvent.click(trigger);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
