import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import {
  agentRuntimeApi,
  type AgentSession,
  type QueuedInput,
} from "../../../../lib/api/agentRuntime";
import { runtimeMedia } from "../../../../lib/api/runtimeMedia";
import { SessionComposer } from "../SessionComposer";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useQueuedInputDraftStore } from "../state/queuedInputDraftStore";
import { useSessionComposerSelections } from "../useSessionComposerSelection";

vi.mock("../AgentInteractionPanel", () => ({
  AgentInteractionPanel: () => null,
}));
vi.mock("../RuntimeRecoveryPanel", () => ({
  RuntimeRecoveryPanel: () => null,
}));
vi.mock("../composer/useAcpDiscovery", () => ({ useAcpDiscovery: () => [] }));
vi.mock("../../settings/useConfig", () => ({
  useConfig: () => ({
    providers: [],
    globalConfig: null,
    effectiveConfig: null,
  }),
}));
vi.mock("../useComposerCommands", async () => {
  const { useRef } = await import("react");
  return {
    useComposerCommands: () => ({ inputRef: useRef(null), overlayOpen: false }),
  };
});
vi.mock("../composer/AgentComposer", () => ({
  AgentComposer: (props: any) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <textarea
        ref={props.commands.inputRef}
        aria-label="Message"
        value={props.content}
        disabled={props.disabled}
        onChange={(event) => props.onContentChange(event.target.value)}
      />
      <output data-testid="attachments">{props.media.parts.length}</output>
      <button disabled={props.disabled} type="submit">
        Send
      </button>
    </form>
  ),
}));

const session = {
  id: "s1",
  projectId: "p1",
  profileId: "synax",
  status: "running",
  activeRunId: "r1",
  sessionMetadata: { mode: "chat" },
  childSessionIds: [],
} as unknown as AgentSession;
const item: QueuedInput = {
  id: "q1",
  message: "Queued task",
  model: "api/model",
  reasoningEffort: "high",
  enqueuedAt: "",
  references: [{ kind: "file", path: "src/app.ts" } as never],
};
beforeEach(() => {
  vi.restoreAllMocks();
  useSessionComposerSelections.setState({
    selections: {},
    lastSubmittedByProject: {},
  });
  useQueuedInputDraftStore.setState({ drafts: {} });
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    sessions: [session],
    selectedSessionId: session.id,
    inputQueues: { s1: [item] },
    loadInputQueue: vi.fn(async () => {}),
    interactionState: {
      sessionId: "s1",
      items: [],
      loading: false,
      error: null,
    },
  });
  vi.spyOn(agentRuntimeApi, "listBackends").mockResolvedValue({ items: [] });
});
function show() {
  return render(
    <MemoryRouter>
      <SessionComposer projectId="p1" session={session} />
    </MemoryRouter>,
  );
}

it("removes the queued message before restoring its text and references, then resubmits the edited draft", async () => {
  let finish!: () => void;
  const remove = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          useAgentSessionStore.getState().setInputQueue("s1", []);
          resolve();
        };
      }),
  );
  const send = vi.fn(async () => "queued" as const);
  useAgentSessionStore.setState({
    removeQueuedInput: remove,
    submitOrEnqueueSessionInput: send,
  });
  show();
  fireEvent.click(screen.getByRole("button", { name: "编辑队列消息 1" }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith("s1", "q1"));
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await act(async () => finish());
  const input = screen.getByRole("textbox", { name: "Message" });
  expect(input).toHaveValue("Queued task");
  expect(
    screen.queryByRole("button", { name: "编辑队列消息 1" }),
  ).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: "Edited task" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        message: "Edited task",
        references: item.references,
        model: item.model,
      }),
    ),
  );
});

it("preserves the queue when removal fails and does not overwrite an existing draft", async () => {
  const remove = vi.fn().mockRejectedValue(new Error("Already running"));
  useAgentSessionStore.setState({ removeQueuedInput: remove });
  show();
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: "Unsent text" } });
  expect(screen.getByRole("button", { name: "编辑队列消息 1" })).toBeDisabled();
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "编辑队列消息 1" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Already running");
  expect(input).toHaveValue("");
  expect(useAgentSessionStore.getState().inputQueues.s1).toEqual([item]);
});

it("restores existing attachments without uploading them again", async () => {
  const withMedia = {
    ...item,
    contentParts: [{ type: "image" as const, assetId: "asset-one" }],
  };
  useAgentSessionStore.getState().setInputQueue("s1", [withMedia]);
  vi.spyOn(runtimeMedia, "metadata").mockResolvedValue({
    asset: {
      id: "asset-one",
      filename: "image.png",
      mediaType: "image/png",
      size: 1024,
    } as never,
  });
  vi.spyOn(runtimeMedia, "blob").mockResolvedValue(new Blob(["image"]));
  const upload = vi.spyOn(runtimeMedia, "upload");
  useAgentSessionStore.setState({
    removeQueuedInput: vi.fn(async () => {
      useAgentSessionStore.getState().setInputQueue("s1", []);
    }),
  });
  show();
  fireEvent.click(screen.getByRole("button", { name: "编辑队列消息 1" }));
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      "Queued task",
    ),
  );
  expect(screen.getByTestId("attachments")).toHaveTextContent("1");
  expect(upload).not.toHaveBeenCalled();
});

it("does not remove the queue item if its attachments cannot be restored", async () => {
  useAgentSessionStore
    .getState()
    .setInputQueue("s1", [
      { ...item, contentParts: [{ type: "image", assetId: "missing" }] },
    ]);
  vi.spyOn(runtimeMedia, "metadata").mockRejectedValue(
    new Error("Attachment unavailable"),
  );
  vi.spyOn(runtimeMedia, "blob").mockRejectedValue(
    new Error("Attachment unavailable"),
  );
  const remove = vi.fn(async () => {});
  useAgentSessionStore.setState({ removeQueuedInput: remove });
  show();
  fireEvent.click(screen.getByRole("button", { name: "编辑队列消息 1" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Attachment unavailable",
  );
  expect(remove).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
});

it("keeps an in-flight queue edit for its original session after navigating away", async () => {
  let finish!: () => void;
  const remove = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          useAgentSessionStore.getState().setInputQueue("s1", []);
          resolve();
        };
      }),
  );
  useAgentSessionStore.setState({ removeQueuedInput: remove });
  const view = show();
  fireEvent.click(screen.getByRole("button", { name: "编辑队列消息 1" }));
  await waitFor(() => expect(remove).toHaveBeenCalledOnce());
  view.unmount();
  await act(async () => finish());
  expect(useQueuedInputDraftStore.getState().drafts.s1.item.id).toBe("q1");
  const other = { ...session, id: "s2" };
  const next = render(
    <MemoryRouter>
      <SessionComposer projectId="p1" session={other} />
    </MemoryRouter>,
  );
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
  next.rerender(
    <MemoryRouter>
      <SessionComposer projectId="p1" session={session} />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      "Queued task",
    ),
  );
  expect(useQueuedInputDraftStore.getState().drafts.s1).toBeUndefined();
});
