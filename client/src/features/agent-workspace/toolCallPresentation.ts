import {
  FileEdit,
  FileSearch,
  FolderOpen,
  GitBranch,
  Search,
  Terminal,
  Wrench,
  Globe,
  Database,
  Monitor,
  Image,
  ListChecks,
  BookOpen,
} from "lucide-react";
import { t, type I18nKey, type Locale } from "../../shared/lib/i18n";
import type { ToolCallView } from "./buildInterleavedTurns";

const TOOLS: Record<string, { label: I18nKey; icon: typeof Wrench }> = {
  "file.read": { label: "activityToolRead", icon: FileSearch },
  "file.write": { label: "activityToolWrite", icon: FileEdit },
  "file.patch": { label: "activityToolEdit", icon: FileEdit },
  "file.list": { label: "activityToolList", icon: FolderOpen },
  "rg": { label: "activityToolSearch", icon: Search },
  "file.search": { label: "activityToolSearch", icon: Search },
  bash: { label: "activityToolRun", icon: Terminal },
  "verification.run": { label: "activityToolVerify", icon: Terminal },
};

const CATEGORY_ICONS: Record<string, typeof Wrench> = {
  external_execution: Terminal,
  shell: Terminal,
  write: FileEdit,
  read: FileSearch,
  search: Search,
  context: Search,
  task: GitBranch,
};

// Presentation aliases only: runtime identifiers and raw payloads stay intact.
const ALIASES: Record<string, [string, string, typeof Wrench]> = {
  "agent.discover": ["查找可用工具", "Find tools", Search],
  "agent.execute": ["执行工具步骤", "Run tool steps", ListChecks],
  "agent.adapt": ["调整助手配置", "Configure assistant", Wrench],
  "webSearch": ["搜索网页", "Search the web", Globe],
  "web.search": ["搜索网页", "Search the web", Globe],
  "web_search": ["搜索网页", "Search the web", Globe],
  "search_web": ["搜索网页", "Search the web", Globe],
  "context.read": ["读取会话上下文", "Read conversation context", BookOpen],
  "skill.load": ["加载技能", "Load skill", BookOpen],
  "diff.read": ["查看代码变更", "View changes", GitBranch],
  "file.delete": ["删除文件", "Delete file", FileEdit],
  "media.read": ["查看媒体", "View media", Image],
  "media.generate": ["生成媒体", "Generate media", Image],
  "computer.use": ["操作电脑", "Use computer", Monitor],
  "browser.open": ["打开网页", "Open page", Globe],
  "browser.navigate": ["访问网页", "Navigate to page", Globe],
  "browser.click": ["点击网页元素", "Click page element", Globe],
  "browser.snapshot": ["查看网页内容", "Inspect page", Globe],
  "browser.screenshot": ["截取网页", "Capture page", Globe],
  "browser.close": ["关闭网页", "Close page", Globe],
  "task.create": ["添加待办", "Add task", ListChecks],
  "task.update": ["更新待办", "Update task", ListChecks],
  "task.get": ["查看待办", "View task", ListChecks],
  "task.list": ["查看待办列表", "List tasks", ListChecks],
  "plan.propose": ["提交实施计划", "Propose plan", ListChecks],
  "human.ask": ["确认任务细节", "Clarify task", ListChecks],
  "mode.switch": ["切换工作模式", "Switch workflow", ListChecks],
  "subagent.delegate": ["委派子任务", "Delegate task", GitBranch],
  "design.write": ["保存设计稿", "Save design", Image],
  "design.preview": ["预览设计稿", "Preview design", Image],
  "design.transition": ["更新设计状态", "Update design status", Image],
  "design.implement": ["实现设计稿", "Implement design", Image],
  "list_database_connections": ["查看数据库连接", "List database connections", Database],
  "execute_query": ["执行数据库查询", "Execute query", Database],
  "execute_sql": ["执行 SQL", "Execute SQL", Database],
  "list_tables": ["查看数据表", "List tables", Database],
  "get_table_schema": ["查看表结构", "View table schema", Database],
  "get_accessibility_tree": ["查看界面结构", "Inspect interface", Monitor],
  "get_desktop_state": ["查看桌面状态", "Inspect desktop", Monitor],
  "get_screen_size": ["获取屏幕尺寸", "Get screen size", Monitor],
  "find_references": ["查找代码引用", "Find references", Search],
  "get_code_knowledge": ["查询代码知识", "Explore code knowledge", Search],
  "get_api_by_path": ["查看接口信息", "Inspect API", Search],
};

export function toolCallPresentation(
  call: Pick<ToolCallView, "toolId" | "inputSummary"> & { category?: string },
  locale: Locale = "zh",
) {
  const tool = TOOLS[call.toolId];
  const isMcp = /^(?:mcp\.|mcp__)/.test(call.toolId);
  const operation = isMcp
    ? (call.toolId.startsWith("mcp__")
        ? call.toolId.split("__").slice(2).join("__")
        : call.toolId.split(".").slice(2).join("."))
    : call.toolId;
  const alias = ALIASES[call.toolId] ?? (isMcp ? ALIASES[operation] : undefined);
  const readable = operation
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .trim();
  const name = tool ? t(locale, tool.label)
    : alias ? alias[locale === "zh" ? 0 : 1]
    : readable ? readable.charAt(0).toUpperCase() + readable.slice(1)
    : locale === "zh" ? "调用工具" : "Run tool";
  let target = "";
  try {
    const input: unknown = JSON.parse(call.inputSummary);
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const values = input as Record<string, unknown>;
      for (const key of [
        "command",
        "query",
        "pattern",
        "url",
        "path",
        "file_path",
        "name",
        "skillId",
        "subject",
      ]) {
        if (typeof values[key] === "string" && values[key].trim()) {
          target = values[key];
          break;
        }
      }
    }
  } catch {
    // Runtime summaries truncate JSON after serialization. Keep a complete
    // leading target string when the later file content has been cut off.
    const match =
      /(?:^|[,{])\s*"(?:command|query|pattern|url|path|file_path|name|skillId|subject)"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(
        call.inputSummary,
      );
    if (match) {
      try {
        target = JSON.parse(match[1]) as string;
      } catch {
        /* Fall back to the unparsed summary. */
      }
    }
  }
  if (!target && !/^[\s]*[\[{]/.test(call.inputSummary)) {
    const plain = call.inputSummary.replace(/\s+/g, " ").trim();
    target = plain.length > 100 ? `${plain.slice(0, 99)}…` : plain;
  }
  return {
    label: tool?.label,
    name,
    source: isMcp ? "MCP" : undefined,
    icon: tool?.icon ?? alias?.[2] ?? CATEGORY_ICONS[call.category ?? ""] ?? Wrench,
    target,
  };
}

export function aggregateToolStatus(calls: ToolCallView[]): string {
  for (const status of [
    "failed",
    "running",
    "denied",
    "cancelled",
    "pending",
  ]) {
    if (calls.some((call) => call.status === status)) return status;
  }
  if (calls.every((call) => call.status === "completed")) return "completed";
  return calls.find((call) => call.status !== "completed")?.status ?? "pending";
}
