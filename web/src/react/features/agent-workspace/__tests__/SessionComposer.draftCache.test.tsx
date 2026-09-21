import { resetSessionComposerDrafts } from "../state/sessionComposerDraftStore";
import { mediaDraftItems } from "../../media/useMediaDraft";
import { useWikiStore } from "../../../state/wikiStore";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeApi,
  type AgentSession,
} from "../../../../lib/api/agentRuntime";
import { sessionPromptApi } from "../../../../lib/api/sessionPrompt";
import {
  runtimeMedia,
  type RuntimeAsset,
} from "../../../../lib/api/runtimeMedia";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useAgentDockStore } from "../state/agentDockStore";
import { useAcpDiscovery } from "../composer/useAcpDiscovery";
import {
  clearDraftComposer,
  loadDraftComposer,
  loadDraftComposerContext,
  saveDraftComposerContext,
} from "../state/draftComposerStore";
import { SessionComposer } from "../SessionComposer";
import { useSessionComposerSelections } from "../useSessionComposerSelection";
import type { ReactNode } from "react";
import type { ComposerCommands } from "../composer/AgentComposer";

vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../../../../lib/api/runtimeEventBus", () => ({
  subscribe: () => vi.fn(),
}));
vi.mock("../../../../lib/api/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
}));
vi.mock("../composer/useAcpDiscovery", () => ({
  useAcpDiscovery: vi.fn(),
}));
vi.mock("../../settings/useConfig", () => ({
  useConfig: () => ({
    providers: [{ id: "api", kind: "api" }],
    globalConfig: null,
    effectiveConfig: null,
  }),
}));
vi.mock("../composer/AgentComposer", () => ({
  AgentComposer: (props: {
    commands?: ComposerCommands;
    modeControl?: ReactNode;
    content: string;
    onContentChange: (value: string) => void;
    onSubmit: () => void;
    disabled: boolean;
  }) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      {props.modeControl}
      {props.commands?.header}
      {props.commands?.trigger}
      <textarea
        ref={props.commands?.inputRef}
        aria-label="Message"
        value={props.content}
        disabled={props.disabled}
        onKeyDown={(event) => props.commands?.onKeyDown(event)}
        onChange={(event) => {
          props.onContentChange(event.target.value);
          props.commands?.onInput(
            event.target.value,
            event.target.selectionStart,
          );
        }}
      />
      <button type="submit" disabled={props.disabled}>
        Send
      </button>
    </form>
  ),
}));

const session: AgentSession = {
  id: "s1",
  projectId: "p1",
  parentSessionId: null,
  childSessionIds: [],
  nodeId: null,
  profileId: "synax",
  status: "completed",
  title: null,
  prompt: "Task",
  contextSnapshotId: null,
  thinkingMode: "standard",
  createdAt: "",
  updatedAt: "",
  completedAt: null,
  resultSummary: null,
  blockedReason: null,
  skillIds: [],
  activeRunId: null,
  pendingResumeToken: null,
  model: "test-model",
  sessionMetadata: { mode: "chat" },
};

const renderDraft = () =>
  render(
    <MemoryRouter>
      <SessionComposer projectId="p1" />
    </MemoryRouter>,
  );

const typeDraft = async (value: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value },
  });
  await waitFor(() => expect(loadDraftComposer("p1")).toBe(value));
};

const ASSET_ID = "asset_0f0e0d0c0b0a09080706050403020100";
const asset: RuntimeAsset = {
  id: ASSET_ID,
  projectId: "p1",
  filename: "shot.png",
  mediaType: "image/png",
  size: 3,
  sha256: "aa",
  createdAt: "2026-01-01T00:00:00Z",
};
const cachedContext = {
  parts: [{ type: "image" as const, assetId: ASSET_ID }],
  references: [{ kind: "skill" as const, id: "sk1", label: "Skill" }],
};

beforeEach(() => {
  resetSessionComposerDrafts();
  mediaDraftItems.reset();
  vi.restoreAllMocks();
  clearDraftComposer("p1");
  useSessionComposerSelections.setState({
    selections: {},
    lastSubmittedByProject: {},
  });
  vi.mocked(useAcpDiscovery).mockReturnValue([]);
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    sessions: [session],
    selectedSessionId: "s1",
  });
  useAgentDockStore.setState({
    composerProviderId: "api",
    composerModelId: "test-model",
    composerPermissionTier: "boundary",
    composerReasoningEffort: "high",
    composerWikiAttachMode: "auto",
    composerDocumentId: null,
  });
  useWikiStore.setState({
    documents: [],
    loadProjectSnapshot: vi.fn(async () => {}),
  });
  vi.spyOn(agentRuntimeApi, "listInteractions").mockResolvedValue({
    interactions: [],
  });
  vi.spyOn(agentRuntimeApi, "listInputQueue").mockResolvedValue({ items: [] });
  vi.spyOn(agentRuntimeApi, "listBackends").mockResolvedValue({ items: [] });
});

describe("SessionComposer draft cache", () => {
  it("keeps new-session input across unmount/remount", async () => {
    const first = renderDraft();
    await typeDraft("Remember me");
    first.unmount();

    renderDraft();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      "Remember me",
    );
  });

  it("drops the cached draft once the new session is submitted", async () => {
    vi.spyOn(sessionPromptApi, "build").mockResolvedValue({
      prompt: "Remember me",
      wikiContext: { mode: "auto", documentId: null },
    } as never);
    vi.spyOn(agentRuntimeApi, "createSession").mockResolvedValue({
      session,
      context: null,
      profile: {} as never,
    });
    const send = vi.fn(async () => {});
    useAgentSessionStore.setState({ sendSessionMessage: send });

    renderDraft();
    await typeDraft("Remember me");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(loadDraftComposer("p1")).toBe(""));
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    expect(send).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ message: "Remember me" }),
    );
  });

  it("keeps the cached draft when the submit fails", async () => {
    vi.spyOn(sessionPromptApi, "build").mockRejectedValue(new Error("offline"));
    renderDraft();
    await typeDraft("Keep me");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      "Keep me",
    );
    expect(loadDraftComposer("p1")).toBe("Keep me");
  });

  it("restores cached attachments and references without re-uploading", async () => {
    saveDraftComposerContext("p1", cachedContext);
    const metadata = vi
      .spyOn(runtimeMedia, "metadata")
      .mockResolvedValue({ asset });
    const upload = vi.spyOn(runtimeMedia, "upload");

    renderDraft();
    await typeDraft("With context");

    await waitFor(() =>
      expect(loadDraftComposerContext("p1")).toEqual(cachedContext),
    );
    expect(metadata).toHaveBeenCalledWith(ASSET_ID);
    expect(upload).not.toHaveBeenCalled();
  });

  it("drops cached attachments whose assets no longer resolve", async () => {
    saveDraftComposerContext("p1", cachedContext);
    vi.spyOn(runtimeMedia, "metadata").mockRejectedValue(new Error("gone"));
    const upload = vi.spyOn(runtimeMedia, "upload");

    renderDraft();
    await typeDraft("Stale file");

    await waitFor(() =>
      expect(loadDraftComposerContext("p1").parts).toEqual([]),
    );
    expect(loadDraftComposerContext("p1").references).toEqual(
      cachedContext.references,
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("clears the cached attachments and references once submitted", async () => {
    saveDraftComposerContext("p1", cachedContext);
    vi.spyOn(runtimeMedia, "metadata").mockResolvedValue({ asset });
    vi.spyOn(sessionPromptApi, "build").mockResolvedValue({
      prompt: "With context",
      wikiContext: { mode: "auto", documentId: null },
    } as never);
    vi.spyOn(agentRuntimeApi, "createSession").mockResolvedValue({
      session,
      context: null,
      profile: {} as never,
    });
    useAgentSessionStore.setState({ sendSessionMessage: vi.fn(async () => {}) });

    renderDraft();
    await typeDraft("With context");
    await waitFor(() =>
      expect(loadDraftComposerContext("p1")).toEqual(cachedContext),
    );

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(loadDraftComposerContext("p1")).toEqual({
        parts: [],
        references: [],
      }),
    );
    expect(loadDraftComposer("p1")).toBe("");
  });
});
