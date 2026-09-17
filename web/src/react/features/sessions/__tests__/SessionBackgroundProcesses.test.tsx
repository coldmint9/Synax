import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { SessionBackgroundProcesses } from "../SessionBackgroundProcesses";
import { agentRuntimeApi } from "../../../../lib/api/agentRuntime";
vi.mock("../../../../lib/api/agentRuntime", () => ({
  agentRuntimeApi: {
    listSessionProcesses: vi.fn(),
    stopSessionProcess: vi.fn(),
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
