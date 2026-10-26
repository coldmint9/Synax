import { resetSessionComposerDrafts } from "../state/sessionComposerDraftStore";
import {
  mediaDraftItems,
  resetMediaUploadQueue,
} from "../../media/useMediaDraft";
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
} from "../../../adapters/transport/agentRuntime";
import {
  runtimeMedia,
  type RuntimeAsset,
} from "../../../adapters/transport/runtimeMedia";
import { SessionComposer } from "../SessionComposer";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useQueuedInputDraftStore } from "../state/queuedInputDraftStore";
import { useSessionComposerSelections } from "../useSessionComposerSelection";

vi.mock("../AgentInteractionPanel", () => ({
  AgentInteractionPanel: () => null,
}));
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
        aria-label="Message"
        value={props.content}
        onChange={(event) => props.onContentChange(event.target.value)}
      />
      <button
        type="button"
        onClick={() =>
          props.media.add([
            new File(["image"], "a.png", { type: "image/png" }),
          ])
        }
      >
        Attach
      </button>
      <output data-testid="parts">{props.media.parts.length}</output>
      <button type="submit">Send</button>
    </form>
  ),
}));

const session = {
  id: "s1",
  projectId: "p1",
  profileId: "synax",
  status: "completed",
  sessionMetadata: { mode: "chat" },
  childSessionIds: [],
} as unknown as AgentSession;

beforeEach(() => {
  resetSessionComposerDrafts();
  mediaDraftItems.reset();
  resetMediaUploadQueue();
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
    inputQueues: { s1: [] },
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

it("sends while an attachment is still uploading and waits for its asset", async () => {
  let finish!: (asset: RuntimeAsset) => void;
  vi.spyOn(runtimeMedia, "upload").mockImplementation(
    () =>
      new Promise<RuntimeAsset>((resolve) => {
        finish = resolve;
      }),
  );
  const send = vi.fn(async () => "sent" as const);
  useAgentSessionStore.setState({ submitOrEnqueueSessionInput: send });

  render(
    <MemoryRouter>
      <SessionComposer projectId="p1" session={session} />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Attach" }));
  expect(screen.getByTestId("parts")).toHaveTextContent("0");
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "hello" },
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
  });
  // The send waits for the upload instead of refusing to start.
  expect(send).not.toHaveBeenCalled();

  await act(async () =>
    finish({
      id: "asset-a",
      filename: "a.png",
      mediaType: "image/png",
      size: 5,
    } as RuntimeAsset),
  );

  await waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        message: "hello",
        contentParts: [
          { type: "text", text: "hello" },
          { type: "image", assetId: "asset-a" },
        ],
      }),
    ),
  );
});
