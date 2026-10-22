import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
vi.mock("./GitActionDialog", () => ({
  default: ({ intent, session, onTaskReady }: any) => (
    <div role="dialog" aria-label={intent}>
      <span>{session.id}</span>
      <button onClick={onTaskReady}>Done</button>
    </div>
  ),
}));
import ComposerGitActions from "./ComposerGitActions";
import type { AgentSession } from "../../../adapters/transport/agentRuntime";
const session = { id: "owner", projectId: "p" } as AgentSession;
describe("explicit composer Git entries", () => {
  it("renders exactly Commit and PR above the composer without creating sessions until clicked", async () => {
    const ensure = vi.fn().mockResolvedValue(session);
    const open = vi.fn();
    render(
      <ComposerGitActions
        projectId="p"
        ensureSession={ensure}
        onOpenConversation={open}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Commit", exact: true }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "PR", exact: true }),
    ).toBeVisible();
    expect(ensure).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "PR", exact: true }));
    expect(await screen.findByRole("dialog", { name: "pr" })).toHaveTextContent(
      "owner",
    );
    expect(ensure).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Done"));
    expect(open).toHaveBeenCalledWith("owner");
  });
  it("uses the existing owner and blocks history/running actions", async () => {
    const ensure = vi.fn();
    const { rerender } = render(
      <ComposerGitActions
        session={session}
        projectId="p"
        ensureSession={ensure}
        onOpenConversation={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Commit", exact: true }),
    );
    await screen.findByRole("dialog", { name: "commit" });
    expect(ensure).not.toHaveBeenCalled();
    rerender(
      <ComposerGitActions
        session={session}
        projectId="p"
        disabled
        ensureSession={ensure}
        onOpenConversation={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "PR", exact: true }),
    ).toBeDisabled();
  });
  it("does not open a stale workspace after async creation", async () => {
    let resolve!: (s: AgentSession) => void;
    const ensure = vi.fn(
      () =>
        new Promise<AgentSession>((r) => {
          resolve = r;
        }),
    );
    const { rerender } = render(
      <ComposerGitActions
        projectId="p"
        ensureSession={ensure}
        onOpenConversation={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "PR", exact: true }));
    rerender(
      <ComposerGitActions
        projectId="other"
        ensureSession={ensure}
        onOpenConversation={vi.fn()}
      />,
    );
    await act(async () => resolve(session));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
