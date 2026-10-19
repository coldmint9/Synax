import { fireEvent, render, screen } from "@testing-library/react";
import { it } from "vitest";
import { ToolCallSummaryLine } from "../ToolCallSummaryLine";
import type { ToolCallView } from "../buildInterleavedTurns";

const call: ToolCallView = {
  id: "call-1",
  toolId: "mcp.custom.list_database_connections",
  inputSummary: '{}',
  outputSummary: '{"connections":[]}',
  status: "completed",
  category: "read",
  duration: "607ms",
  mutability: "read",
};

it("a", () => {
  const { container } = render(<ToolCallSummaryLine call={call} />);
  fireEvent.click(screen.getByRole("button"));
  console.log("A>>", container.querySelectorAll("pre").length);
});

it("b", () => {
  const edit = { ...call, toolId: "file.patch", inputSummary: JSON.stringify({ patch: "x" }) };
  const { container } = render(<ToolCallSummaryLine call={edit} />);
  console.log("B-pre>>", container.querySelector("button")?.getAttribute("aria-expanded"));
  fireEvent.click(screen.getByRole("button"));
  console.log("B>>", container.querySelectorAll("pre").length, container.querySelector("button")?.getAttribute("aria-expanded"));
});
