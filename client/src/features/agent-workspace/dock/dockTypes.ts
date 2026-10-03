export type AgentDockMorph = "bar" | "mini" | "pill-input" | "pill-expanded";

export function dockStateToMorph(
  state: "idle" | "prompt" | "input" | "working" | "expanded",
): AgentDockMorph {
  switch (state) {
    case "prompt":
    case "working":
      return "mini";
    case "input":
      return "pill-input";
    case "expanded":
      return "pill-expanded";
    default:
      return "bar";
  }
}
