import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { agentRuntimeApi, type AgentRuntimeMessage } from "../../../adapters/transport/agentRuntime";
import HistoricalVisualizationReply from "../HistoricalVisualizationReply";

vi.mock("../../visualizations/InlineVisualization", () => ({
  InlineVisualization: ({ visualization }: { visualization: { html: string } }) =>
    <div data-testid="preview">{visualization.html}</div>,
}));
vi.mock("../StreamingTextBlock", () => ({
  StreamingTextBlock: ({ text }: { text: string }) => <p>{text}</p>,
}));
afterEach(() => vi.restoreAllMocks());
const projected: AgentRuntimeMessage = {
  id: "m", sessionId: "s", runId: "r", stepId: null, role: "assistant",
  content: "Before\n[交互预览]\nAfter", metadata: {}, createdAt: "2026-10-10T00:00:00Z",
  historyProjection: { omittedFields: ["metadata"] },
};
const saved = { ...projected, historyProjection: undefined, metadata: {
  purpose: "work_result", visualizations: [{ id: "preview", start: 7, end: 13,
    html: `<button>${"saved".repeat(6000)}</button>` }],
} };

it("restores a large saved preview and surrounding paragraphs on every remount", async () => {
  const load = vi.spyOn(agentRuntimeApi, "messageVisualization").mockResolvedValue({ message: saved });
  const view = render(<HistoricalVisualizationReply message={projected} />);
  expect(await screen.findByTestId("preview")).toHaveTextContent(saved.metadata.visualizations[0].html);
  expect(screen.getByText("Before")).toBeInTheDocument();
  expect(screen.getByText("After")).toBeInTheDocument();
  view.unmount();
  render(<HistoricalVisualizationReply message={projected} />);
  await screen.findByTestId("preview");
  expect(load).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenLastCalledWith("s", "m");
});

it("does not apply an old session response after the selected message changes", async () => {
  let resolveOld!: (value: { message: AgentRuntimeMessage }) => void;
  vi.spyOn(agentRuntimeApi, "messageVisualization")
    .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValueOnce({ message: { ...saved, id: "next", content: "Other reply", metadata: {} } });
  const view = render(<HistoricalVisualizationReply message={projected} />);
  view.rerender(<HistoricalVisualizationReply message={{ ...projected, id: "next" }} />);
  await screen.findByText("Other reply");
  resolveOld({ message: saved });
  await waitFor(() => expect(screen.queryByTestId("preview")).not.toBeInTheDocument());
});
