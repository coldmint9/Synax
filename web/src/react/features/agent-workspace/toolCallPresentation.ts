import {
  FileEdit,
  FileSearch,
  FolderOpen,
  GitBranch,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { I18nKey } from "../../../lib/i18n";
import type { ToolCallView } from "./buildInterleavedTurns";

const TOOLS: Record<string, { label: I18nKey; icon: typeof Wrench }> = {
  "file.read": { label: "activityToolRead", icon: FileSearch },
  "file.write": { label: "activityToolWrite", icon: FileEdit },
  "file.edit": { label: "activityToolEdit", icon: FileEdit },
  "file.list": { label: "activityToolList", icon: FolderOpen },
  "grep.search": { label: "activityToolSearch", icon: Search },
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

export function toolCallPresentation(call: ToolCallView) {
  const tool = TOOLS[call.toolId];
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
      /(?:^|[,{])\s*"(?:command|query|pattern|url|path|file_path|name)"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(
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
  if (!target) {
    const plain = call.inputSummary.replace(/\s+/g, " ").trim();
    target = plain.length > 100 ? `${plain.slice(0, 99)}…` : plain;
  }
  return {
    label: tool?.label,
    icon: tool?.icon ?? CATEGORY_ICONS[call.category] ?? Wrench,
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
