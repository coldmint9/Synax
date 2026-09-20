import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { SessionBackgroundProcesses } from "../SessionBackgroundProcesses";
import { agentRuntimeApi } from "../../../../lib/api/agentRuntime";
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

it("keeps the service header visible when empty and supports folding", async () => {
  vi.mocked(agentRuntimeApi.listSessionProcesses).mockResolvedValue({
    items: [],
  });
  render(<SessionBackgroundProcesses sessionId="empty" />);
  const header = await screen.findByRole("button", {
    name: /Background services/,
  });
  expect(header).toHaveAttribute("aria-expanded", "true");
  await userEvent.click(header);
  expect(header).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("No background services")).not.toBeInTheDocument();
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
  await user.click(button);
  expect(
    await screen.findByRole("dialog", { name: "Stop and delete?" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await user.click(button);
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
  await userEvent.click(
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
  await userEvent.click(
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
  await userEvent.click(
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
