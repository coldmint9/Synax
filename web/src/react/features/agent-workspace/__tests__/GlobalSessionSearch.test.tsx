import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { GlobalSessionSearch } from "../GlobalSessionSearch";
import { agentRuntimeApi, type AgentSession } from "../../../../lib/api/agentRuntime";
import { useShellStore } from "../../../state/shellStore";

const sessions = [
  { id: "chat & 1", projectId: "route-project", title: "needle chat", prompt: "hello", profileId: "synax", sessionMetadata: {} },
  { id: "workflow", projectId: "route-project", title: "needle workflow", prompt: "hello", profileId: "wiki-refresh", sessionMetadata: {} },
] as AgentSession[];
function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname}{location.search}</output>; }
function mount(path = "/projects/route-project/wiki") {
  return render(<MemoryRouter initialEntries={[path]}><textarea aria-label="Editor" /><GlobalSessionSearch /><Location /></MemoryRouter>);
}
function shortcut(metaKey = false) { fireEvent.keyDown(window, { key: "f", metaKey, ctrlKey: !metaKey }); }
async function search() {
  shortcut();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "needle" } });
  await screen.findAllByRole("option");
}

describe("GlobalSessionSearch", () => {
  beforeEach(() => {
    useShellStore.setState({ currentProjectId: "stored-project", projects: [] });
    vi.spyOn(agentRuntimeApi, "searchSessions").mockResolvedValue({ items: sessions.map(session => ({ session, snippet: "matching needle text" })), hasMore: false });
  });
  afterEach(() => vi.restoreAllMocks());
  it.each([true, false])("opens from an editor with Command/Control F and restores focus on Escape: %s", async metaKey => {
    mount();
    const editor = screen.getByRole("textbox", { name: "Editor" });
    editor.focus();
    const event = new KeyboardEvent("keydown", { key: "f", metaKey, ctrlKey: !metaKey, bubbles: true, cancelable: true });
    act(() => { editor.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(editor).toHaveFocus();
  });
  it("searches the route workspace, highlights matches and opens the chosen workflow", async () => {
    mount(); await search();
    expect(vi.mocked(agentRuntimeApi.searchSessions).mock.calls[0].slice(0, 2)).toEqual(["route-project", "needle"]);
    const input = screen.getByRole("combobox");
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[0].querySelectorAll("mark")).toHaveLength(2);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/route-project/sessions/workflows?session=workflow");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("wraps selection, ignores IME Enter, and encodes the selected session route", async () => {
    mount(); await search();
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/route-project/sessions?session=chat%20%26%201");
  });
  it("uses the current workspace on settings and refocuses an already open search", async () => {
    mount("/settings"); await search();
    expect(vi.mocked(agentRuntimeApi.searchSessions).mock.calls[0][0]).toBe("stored-project");
    screen.getByRole("button", { name: /关闭搜索|Close search/ }).focus();
    shortcut(true);
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
  it("does not issue an unscoped search without a workspace", async () => {
    useShellStore.setState({ currentProjectId: null });
    mount("/"); shortcut();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "needle" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(screen.getByText(/请先打开一个工作区|Open a workspace to search/)).toBeInTheDocument());
    expect(agentRuntimeApi.searchSessions).not.toHaveBeenCalled();
  });
});
