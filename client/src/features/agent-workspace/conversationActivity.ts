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

/**
 * One path, as opposed to prose, a patch body or a glob.
 *
 * A read/edit record can only offer "open this file" when its input names
 * exactly one workspace file: a multi-file patch joins its targets with `, `,
 * and a raw patch or shell command is prose the viewer cannot open.
 */
const SINGLE_PATH = /^[^\s*?"'`|<>()[\]]+$/;

function singleFilePath(value: string): string | null {
  const trimmed = value.trim();
  return trimmed && SINGLE_PATH.test(trimmed) ? trimmed : null;
}

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
    /** The single file this record points at, when the viewer can open it. */
    filePath: file ? singleFilePath(target) : null,
    additions,
    deletions,
  };
}

type LiveLabelKind = "edit" | "read" | "run" | "search" | "load" | "tool";

const liveLabels = {
  zh: {
    analyze: "正在分析任务",
    waitingModel: "正在等待模型继续",
    generating: "正在整理结果",
    cancelling: "正在停止当前操作",
    queued: {
      search: "正在准备搜索",
      command: "正在准备命令执行",
      io: "正在准备文件访问",
      worker: "正在分配执行环境",
      provider: "正在等待模型资源",
      fallback: "正在准备执行资源",
    },
    action: {
      edit: "正在修改文件",
      read: "正在读取文件",
      run: "正在执行命令",
      search: "正在搜索代码",
      load: "正在加载工具",
      tool: "正在处理工具调用",
    },
    parallel: (count: number) => `正在并行处理 ${count} 个任务`,
    scanned: (files: number) => `正在搜索代码 · 已扫描 ${files} 个文件`,
  },
  en: {
    analyze: "Analyzing the task",
    waitingModel: "Waiting for the model to continue",
    generating: "Preparing the result",
    cancelling: "Stopping the current operation",
    queued: {
      search: "Preparing search",
      command: "Preparing command execution",
      io: "Preparing file access",
      worker: "Allocating an execution environment",
      provider: "Waiting for model capacity",
      fallback: "Preparing execution resources",
    },
    action: {
      edit: "Editing files",
      read: "Reading files",
      run: "Running a command",
      search: "Searching the code",
      load: "Loading a tool",
      tool: "Processing a tool call",
    },
    parallel: (count: number) => `Processing ${count} tasks in parallel`,
    scanned: (files: number) => `Searching the code · ${files} files scanned`,
  },
} as const;

function liveLabelKind(call: ToolCallView): LiveLabelKind {
  return actionFor(call);
}

function liveLabelForCall(call: ToolCallView, locale: Locale): string {
  const labels = liveLabels[locale];
  const progress = call.execution;
  if (progress?.phase === "cancelling") return labels.cancelling;
  if (progress?.phase === "waiting_model") return labels.waitingModel;
  if (progress?.phase === "generating") return labels.generating;
  if (progress?.phase === "queued_resources") {
    const resource = progress.resource;
    return labels.queued[resource as keyof typeof labels.queued] ?? labels.queued.fallback;
  }
  if (progress?.phase === "executing_tool" && liveLabelKind(call) === "search" && progress.files !== undefined) {
    return labels.scanned(progress.files);
  }
  return labels.action[liveLabelKind(call)];
}

/**
 * Human-readable label for the live activity toggle.
 *
 * Running toggles intentionally omit raw commands, paths, prompts, and model
 * reasoning. The label describes the current event using this priority:
 * execution phase, tool semantics, then a generic turn state.
 */
export function conversationActivityLiveLabel(calls: ToolCallView[], locale: Locale): string {
  const active = calls.filter((call) => call.status === "running" || call.status === "pending");
  if (active.length === 0) {
    const latest = calls[calls.length - 1];
    return latest ? liveLabelForCall(latest, locale) : liveLabels[locale].analyze;
  }
  if (active.length > 1) {
    const labels = new Set(active.map((call) => liveLabelForCall(call, locale)));
    if (labels.size > 1) return liveLabels[locale].parallel(active.length);
  }
  return liveLabelForCall(active[active.length - 1], locale);
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
