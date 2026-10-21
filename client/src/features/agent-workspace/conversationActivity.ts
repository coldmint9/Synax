import { BookOpen, Pencil, Search, SquareTerminal, Wrench } from "lucide-react";
import type { Locale } from "../../shared/lib/i18n";
import type { ToolCallView } from "./buildInterleavedTurns";
import { toolCallPresentation } from "./toolCallPresentation";

type Action = "edit" | "read" | "run" | "search" | "load" | "tool";

function actionFor(call: ToolCallView): Action {
  const id = call.toolId.startsWith("mcp.")
    ? call.toolId.split(".").slice(2).join(".")
    : call.toolId.split("__").pop() ?? call.toolId;
  if (["file.patch", "file.write", "file.delete", "apply_patch", "edit_file", "write_file"].includes(id)) return "edit";
  if (["file.read", "read_file", "read_project_file", "context.read"].includes(id)) return "read";
  if (["bash", "verification.run", "exec_command", "execute_terminal_command", "write_stdin"].includes(id) || ["shell", "exec", "external_execution"].includes(call.category)) return "run";
  if (["rg", "file.search", "web.search", "webSearch"].includes(id) || call.category === "search") return "search";
  if (["agent.discover", "skill.load", "tool_search"].includes(id)) return "load";
  return "tool";
}

const icons = { edit: Pencil, read: BookOpen, run: SquareTerminal, search: Search, load: Wrench, tool: Wrench };
const verbs = {
  zh: { edit: ["已编辑", "正在编辑"], read: ["已读取", "正在读取"], run: ["已运行", "正在运行"], search: ["已搜索", "正在搜索"], load: ["已加载", "正在加载"], tool: ["已调用", "正在调用"] },
  en: { edit: ["Edited", "Editing"], read: ["Read", "Reading"], run: ["Ran", "Running"], search: ["Searched", "Searching"], load: ["Loaded", "Loading"], tool: ["Used", "Using"] },
} as const;

export function conversationToolPresentation(call: ToolCallView, locale: Locale) {
  const presentation = toolCallPresentation(call, locale);
  const action = actionFor(call);
  const running = call.status === "running" || call.status === "pending";
  let label: string = verbs[locale][action][running ? 1 : 0];
  if (action === "run" && call.status === "completed" && call.duration) {
    label = locale === "zh" ? `已在 ${call.duration} 内运行` : `Ran in ${call.duration}`;
  }
  if (action === "tool") label = locale === "zh"
    ? `${running ? "正在" : "已"}${presentation.name}`
    : `${running ? "Using" : "Used"} ${presentation.name}`;
  if (call.toolId === "file.delete") label = locale === "zh" ? (running ? "正在删除" : "已删除") : (running ? "Deleting" : "Deleted");
  const file = action === "edit" || action === "read";
  const plainTarget = /^[\s]*[\[{]/.test(call.inputSummary) ? "" : call.inputSummary.replace(/\s+/g, " ").trim().slice(0, 800);
  const target = plainTarget || presentation.target || (action === "tool" ? "" : presentation.name);
  // Only count an actual supplied patch; never infer edits from prose output.
  let additions = 0;
  let deletions = 0;
  if (action === "edit") {
    try {
      const input = JSON.parse(call.inputSummary);
      const patch = input.patch ?? input.diff;
      if (typeof patch === "string") {
        for (const line of patch.split("\n")) {
          if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
          if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
        }
      }
    } catch { /* Truncated inputs have no reliable diff count. */ }
  }
  return {
    ...presentation,
    icon: icons[action],
    action,
    label,
    target,
    displayTarget: file && !target.includes(", ") ? target.split(/[\\/]/).pop() || target : target,
    file,
    additions,
    deletions,
  };
}

/** Summarize each kind of work once, in the same order as the transcript. */
export function conversationActivitySummary(calls: ToolCallView[], locale: Locale) {
  const counts = new Map<Action, number>();
  for (const call of calls) {
    const action = actionFor(call);
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  const labels = [...counts].map(([action, count]) => {
    if (locale === "en") {
      return { edit: "Edited files", read: "Read files", run: "Ran commands", search: "Searched", load: "Loaded tools", tool: "Used tools" }[action];
    }
    return {
      edit: count > 1 ? "编辑了多个文件" : "编辑了文件",
      read: "读取文件",
      run: "运行了命令",
      search: "进行了搜索",
      load: "加载了工具",
      tool: "调用了工具",
    }[action];
  });
  if (locale === "zh" && counts.keys().next().value === "read") labels[0] = "已读取文件";
  return {
    text: labels.join(locale === "zh" ? "" : ", "),
    icon: icons[counts.keys().next().value ?? "tool"],
  };
}
