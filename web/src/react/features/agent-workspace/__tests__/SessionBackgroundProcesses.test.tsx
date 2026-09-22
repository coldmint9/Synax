import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { SessionBackgroundProcesses } from "../SessionBackgroundProcesses";
import { agentRuntimeApi } from "../../../../lib/api/agentRuntime";
import {
  terminalApi,
  type TerminalSession,
} from "../../../../lib/api/terminal";
import { useTerminalStore } from "../../terminal/terminalStore";
vi.mock("../../../../lib/api/agentRuntime", () => ({
  agentRuntimeApi: {
    listSessionProcesses: vi.fn(),
    stopSessionProcess: vi.fn(),
    deleteSessionProcess: vi.fn(),
  },
}));
vi.mock("../../../../lib/api/runtimeEventBus", () => ({
  subscribe: () => () => {},
}));
vi.mock("../../../../lib/api/terminal", () => ({
  terminalApi: {
    get: vi.fn(),
    create: vi.fn(),
    stop: vi.fn(),
    remove: vi.fn(),
    list: vi.fn(),
  },
}));
vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "en", t: (key: string) => key }),
}));
const process = {
  id: "job",
  command: "npm run dev",
  pid: 42,
  state: "active",
  exitCode: null,
  startedAt: "2026-09-16",
  endedAt: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(agentRuntimeApi.listSessionProcesses).mockResolvedValue({
    items: [process],
  });
});

it("pushes a stopped service terminal's ended state into the terminal drawer", async () => {
  const service = {
    ...process,
    id: "svc",
    terminalId: "term-1",
    kind: "service" as const,
    projectId: "p",
  };
  const terminal = (state: string): TerminalSession => ({
    id: "term-1",
    projectId: "p",
    rootId: "r",
    ownerSessionId: "one",
    kind: "service",
    title: "npm run dev",
    cwd: "/p",
    shell: "/bin/sh",
    command: "npm run dev",
    pid: 42,
    state,
    exitCode: null,
    startedAt: "",
    endedAt: null,
    cols: 80,
    rows: 24,
  });
  vi.mocked(agentRuntimeApi.listSessionProcesses).mockResolvedValue({
    items: [service],
  });
  vi.mocked(agentRuntimeApi.stopSessionProcess).mockResolvedValue({
    items: [{ ...service, state: "closed" }],
  });
  vi.mocked(terminalApi.get).mockResolvedValue(terminal("closed"));
  useTerminalStore.setState({
    open: true,
    tabs: [],
    activeId: null,
    pending: 0,
    error: null,
  });
  useTerminalStore.getState().accept(terminal("active"));
  render(<SessionBackgroundProcesses sessionId="one" />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Stop npm run dev" }),
  );
  await waitFor(() =>
    expect(useTerminalStore.getState().tabs[0]?.terminal.state).toBe("closed"),
  );
  expect(terminalApi.get).toHaveBeenCalledWith("p", "term-1");
});

it("shows the delete confirmation when hovering a service's trash button", async () => {
  vi.mocked(agentRuntimeApi.listSessionProcesses).mockResolvedValue({
    items: [{ ...process, id: "svc", kind: "service" }],
  });
  render(<SessionBackgroundProcesses sessionId="one" />);
  await userEvent.hover(
    await screen.findByRole("button", { name: "Delete record npm run dev" }),
  );
  expect(await screen.findByText("Stop and delete?")).toBeVisible();
});

it("deletes every service record at once and closes their terminal views", async () => {
  const services = [
    {
      ...process,
      id: "svc-1",
      terminalId: "t-1",
      kind: "service" as const,
      projectId: "p",
    },
    {
      ...process,
      id: "svc-2",
      command: "npm run build",
      state: "closed",
      exitCode: 0,
      kind: "service" as const,
      projectId: "p",
    },
    {
      ...process,
      id: "shell-1",
      command: "zsh",
      kind: "terminal" as const,
      projectId: "p",
    },
  ];
  vi.mocked(agentRuntimeApi.listSessionProcesses)
    .mockResolvedValueOnce({ items: services })
    .mockResolvedValue({
      items: [services[2]],
    });
  vi.mocked(agentRuntimeApi.stopSessionProcess).mockResolvedValue({
    items: [],
  });
  vi.mocked(agentRuntimeApi.deleteSessionProcess).mockResolvedValue({
    items: [],
  });
  useTerminalStore.setState({
    open: true,
    tabs: [],
    activeId: null,
    pending: 0,
    error: null,
  });
  useTerminalStore.getState().accept({
    id: "svc-1",
    projectId: "p",
    rootId: "r",
    ownerSessionId: "one",
    kind: "service",
    title: "npm run dev",
    cwd: "/p",
    shell: "/bin/sh",
    command: "npm run dev",
    pid: 42,
    state: "active",
    exitCode: null,
    startedAt: "",
    endedAt: null,
    cols: 80,
    rows: 24,
  } satisfies TerminalSession);
  render(<SessionBackgroundProcesses sessionId="one" />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Delete all services" }),
  );
  await waitFor(() =>
    expect(agentRuntimeApi.deleteSessionProcess).toHaveBeenCalledTimes(2),
  );
  expect(agentRuntimeApi.stopSessionProcess).toHaveBeenCalledTimes(1);
  expect(agentRuntimeApi.stopSessionProcess).toHaveBeenCalledWith(
    "one",
    "svc-1",
  );
  expect(agentRuntimeApi.stopSessionProcess).not.toHaveBeenCalledWith(
    "one",
    "shell-1",
  );
  await waitFor(() => expect(useTerminalStore.getState().tabs).toHaveLength(0));
});

it("lists the owned service and allows retrying a failed stop without double submission", async () => {
  let reject: (error: Error) => void = () => {};
  vi.mocked(agentRuntimeApi.stopSessionProcess)
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue({ items: [{ ...process, state: "closed" }] });
  render(<SessionBackgroundProcesses sessionId="one" />);
  const button = await screen.findByRole("button", {
    name: "Stop npm run dev",
  });
  expect(screen.getByText("PID 42")).toBeInTheDocument();
  await userEvent.dblClick(button);
  expect(agentRuntimeApi.stopSessionProcess).toHaveBeenCalledTimes(1);
  expect(button).toBeDisabled();
  await act(async () => reject(new Error("Could not confirm termination")));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not confirm termination",
  );
  await userEvent.click(button);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Stop npm run dev" }),
    ).not.toBeInTheDocument(),
  );
  expect(agentRuntimeApi.stopSessionProcess).toHaveBeenLastCalledWith(
    "one",
    "job",
  );
});

it("ignores process lists belonging to the session that was left", async () => {
  let resolveOld: (value: any) => void = () => {};
  vi.mocked(agentRuntimeApi.listSessionProcesses).mockImplementation((id) =>
    id === "one"
      ? new Promise((resolve) => {
          resolveOld = resolve;
        })
      : Promise.resolve({ items: [] }),
  );
  const view = render(<SessionBackgroundProcesses sessionId="one" />);
  view.rerender(<SessionBackgroundProcesses sessionId="two" />);
  await act(async () => resolveOld({ items: [process] }));
  expect(screen.queryByText("npm run dev")).not.toBeInTheDocument();
});

it("hides the empty card until a background service is created", async () => {
  vi.mocked(agentRuntimeApi.listSessionProcesses).mockResolvedValue({
    items: [],
  });
  const view = render(<SessionBackgroundProcesses sessionId="empty" />);
  await waitFor(() =>
    expect(agentRuntimeApi.listSessionProcesses).toHaveBeenCalledWith("empty"),
  );
  expect(
    screen.queryByRole("button", { name: /Background services/ }),
  ).not.toBeInTheDocument();
  vi.mocked(agentRuntimeApi.listSessionProcesses).mockResolvedValue({
    items: [{ ...process, kind: "service" }],
  });
  view.rerender(<SessionBackgroundProcesses sessionId="empty-next" />);
  const header = await screen.findByRole("button", {
    name: /Background services/,
  });
  expect(header).toHaveAttribute("aria-expanded", "true");
  await userEvent.click(header);
  expect(header).toHaveAttribute("aria-expanded", "false");
});
it("deletes closed history directly", async () => {
  vi.mocked(agentRuntimeApi.listSessionProcesses).mockResolvedValue({
    items: [{ ...process, state: "closed" }],
  });
  vi.mocked(agentRuntimeApi.deleteSessionProcess).mockResolvedValue({
    items: [],
  });
  render(<SessionBackgroundProcesses sessionId="one" />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Delete record npm run dev" }),
  );
  await waitFor(() =>
    expect(screen.queryByText("npm run dev")).not.toBeInTheDocument(),
  );
  expect(agentRuntimeApi.deleteSessionProcess).toHaveBeenCalledWith(
    "one",
    "job",
  );
  expect(agentRuntimeApi.stopSessionProcess).not.toHaveBeenCalled();
});

it("allows cancelling or dismissing the running service confirmation without stopping", async () => {
  const user = userEvent.setup();
  render(<SessionBackgroundProcesses sessionId="one" />);
  const button = await screen.findByRole("button", {
    name: "Delete record npm run dev",
  });
  expect(button).toBeEnabled();
  await user.hover(button);
  expect(
    await screen.findByRole("dialog", { name: "Stop and delete?" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await user.hover(button);
  await screen.findByRole("dialog");
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(agentRuntimeApi.stopSessionProcess).not.toHaveBeenCalled();
  expect(agentRuntimeApi.deleteSessionProcess).not.toHaveBeenCalled();
});

it("waits for stopping to succeed before deleting and prevents duplicate submission", async () => {
  let finishStop!: (value: any) => void;
  vi.mocked(agentRuntimeApi.stopSessionProcess).mockImplementation(
    () =>
      new Promise((resolve) => {
        finishStop = resolve;
      }),
  );
  vi.mocked(agentRuntimeApi.deleteSessionProcess).mockResolvedValue({
    items: [],
  });
  render(<SessionBackgroundProcesses sessionId="one" />);
  await userEvent.hover(
    await screen.findByRole("button", { name: "Delete record npm run dev" }),
  );
  expect(agentRuntimeApi.stopSessionProcess).not.toHaveBeenCalled();
  await userEvent.dblClick(
    await screen.findByRole("button", { name: "Stop and delete" }),
  );
  expect(agentRuntimeApi.stopSessionProcess).toHaveBeenCalledExactlyOnceWith(
    "one",
    "job",
  );
  expect(agentRuntimeApi.deleteSessionProcess).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Delete record npm run dev" }),
  ).toBeDisabled();
  await act(async () =>
    finishStop({ items: [{ ...process, state: "closed" }] }),
  );
  await waitFor(() =>
    expect(screen.queryByText("npm run dev")).not.toBeInTheDocument(),
  );
  expect(agentRuntimeApi.deleteSessionProcess).toHaveBeenCalledExactlyOnceWith(
    "one",
    "job",
  );
});

it("keeps the record when stopping fails", async () => {
  vi.mocked(agentRuntimeApi.stopSessionProcess).mockRejectedValue(
    new Error("Could not stop service"),
  );
  render(<SessionBackgroundProcesses sessionId="one" />);
  await userEvent.hover(
    await screen.findByRole("button", { name: "Delete record npm run dev" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Stop and delete" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not stop service",
  );
  expect(screen.getByText("npm run dev")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Delete record npm run dev" }),
  ).toBeEnabled();
  expect(agentRuntimeApi.deleteSessionProcess).not.toHaveBeenCalled();
});

it("keeps stopped history available to retry when deletion fails", async () => {
  vi.mocked(agentRuntimeApi.stopSessionProcess).mockResolvedValue({
    items: [{ ...process, state: "closed" }],
  });
  vi.mocked(agentRuntimeApi.deleteSessionProcess)
    .mockRejectedValueOnce(new Error("Delete failed"))
    .mockResolvedValue({ items: [] });
  render(<SessionBackgroundProcesses sessionId="one" />);
  await userEvent.hover(
    await screen.findByRole("button", { name: "Delete record npm run dev" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Stop and delete" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Delete failed");
  expect(
    screen.queryByRole("button", { name: "Stop npm run dev" }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Delete record npm run dev" }),
  );
  await waitFor(() =>
    expect(screen.queryByText("npm run dev")).not.toBeInTheDocument(),
  );
  expect(agentRuntimeApi.stopSessionProcess).toHaveBeenCalledTimes(1);
});

it("does not render manually created terminals", async () => {
  vi.mocked(agentRuntimeApi.listSessionProcesses).mockResolvedValue({
    items: [{ ...process, command: "zsh", kind: "terminal" }],
  });
  render(<SessionBackgroundProcesses sessionId="one" />);
  await waitFor(() =>
    expect(agentRuntimeApi.listSessionProcesses).toHaveBeenCalledWith("one"),
  );
  expect(screen.queryByText("zsh")).not.toBeInTheDocument();
});

it("highlights running services that expose a mapped port in green", async () => {
  vi.mocked(agentRuntimeApi.listSessionProcesses).mockResolvedValue({
    items: [{ ...process, command: "vite --port 5173", ports: [5173] }],
  });
  render(<SessionBackgroundProcesses sessionId="one" />);
  const stop = await screen.findByRole("button", {
    name: "Stop vite --port 5173",
  });
  expect(stop.closest(".bui-process-row")).toHaveClass(
    "bui-process-row--ports",
  );
  expect(screen.getByText(":5173")).toBeInTheDocument();
  // Running is conveyed by colour alone: no spinner/status chip.
  expect(
    document.querySelector(".bui-process-meta .bui-status"),
  ).not.toBeInTheDocument();
});

it("does not highlight services without mapped ports", async () => {
  render(<SessionBackgroundProcesses sessionId="one" />);
  const stop = await screen.findByRole("button", { name: "Stop npm run dev" });
  expect(stop.closest(".bui-process-row")).not.toHaveClass(
    "bui-process-row--ports",
  );
  expect(
    document.querySelector(".bui-process-meta .bui-status"),
  ).not.toBeInTheDocument();
});
