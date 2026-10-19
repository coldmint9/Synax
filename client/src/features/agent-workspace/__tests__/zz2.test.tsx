import { fireEvent, render, screen } from "@testing-library/react";
import { it } from "vitest";
import { ToolCallSummaryLine } from "../ToolCallSummaryLine";
import type { ToolCallView } from "../buildInterleavedTurns";

const call: ToolCallView = {
  id: "call-9",
  toolId: "mcp.custom.list_database_connections",
  inputSummary: '{}',
  outputSummary: '{"connections":[]}',
  status: "completed",
  category: "read",
  duration: "607ms",
  mutability: "read",
};

it("only b", () => {
  const edit = { ...call, toolId: "file.patch", inputSummary: JSON.stringify({ patch: "x" }) };
  const { container } = render(<ToolCallSummaryLine call={edit} />);
  console.log("PRE>>", container.querySelector("button")?.getAttribute("aria-expanded"));
  fireEvent.click(screen.getByRole("button"));
  console.log("POST>>", container.querySelectorAll("pre").length, container.innerHTML.includes("sessionToolDetail"));
});
