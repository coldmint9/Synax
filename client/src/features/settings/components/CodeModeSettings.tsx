import { useEffect, useState } from "react";
import { Code2 } from "lucide-react";
import { Button } from "@/shared/ui/ui/Button";
import { Description, Field, Label, TextArea } from "@/shared/ui/ui/Field";
import type { CodeModeSettings as Config } from "@/shared/contracts/project-settings";
import { SettingsCard } from "./SettingsCard";

export function CodeModeSettings({
  value,
  locale,
  onSave,
}: {
  value?: Config;
  locale: string;
  onSave: (value: Config) => Promise<void>;
}) {
  const zh = locale.startsWith("zh");
  const [mcp, setMcp] = useState((value?.mcpTools ?? []).join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setMcp((value?.mcpTools ?? []).join("\n"));
  }, [value]);
  const dirty = mcp !== (value?.mcpTools ?? []).join("\n");
  const save = async () => {
    const mcpTools = [
      ...new Set(
        mcp
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    ];
    if (
      mcpTools.length > 64 ||
      mcpTools.some(
        (id) =>
          id.length > 256 || !/^mcp\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/.test(id),
      )
    ) {
      setError(
        zh
          ? "请每行填写一个完整 MCP 工具 ID（mcp.server.tool），最多 64 个，不支持通配符。"
          : "Enter one exact MCP tool ID (mcp.server.tool) per line, up to 64. Wildcards are not allowed.",
      );
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await onSave({ mcpTools });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsCard
      title={zh ? "Agent 能力" : "Agent capabilities"}
      icon={Code2}
      description={
        zh ? "原生执行策略 · 按项目管理" : "Native execution policy · Per project"
      }
    >
      <form
        className="grid min-w-0 gap-5 p-4 sm:p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="text-xs leading-relaxed text-muted-foreground">
          {zh
            ? "原生编排默认启用，支持组合读取、搜索、汇总和文件写入操作。各项操作继续遵循现有工具权限与审批要求。"
            : "Native composition is enabled by default and supports reads, searches, summaries and file writes. Each operation follows existing tool permissions and approval requirements."}
        </p>
        <Field disabled={saving}>
          <Label>
            {zh
              ? "允许编排的 MCP 工具（可选）"
              : "Approved MCP tools (optional)"}
          </Label>
          <Description>
            {zh
              ? "每行一个完整工具 ID，例如 mcp.docs.search。仅对已挂载且明确声明只读的工具生效，并继续检查原有权限。请先验证服务器可信；只读声明不是安全保证。留空只使用内置工具。"
              : "One exact tool ID per line, e.g. mcp.docs.search. Tools must be mounted, explicitly read-only and authorized by existing permissions. Verify the server first: its read-only hint is not a security guarantee. Leave empty for built-in tools only."}
          </Description>
          <TextArea
            rows={3}
            value={mcp}
            onChange={(event) => {
              setMcp(event.target.value);
              setSaved(false);
              setError(null);
            }}
            className="font-mono"
            spellCheck={false}
          />
        </Field>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={saving || !dirty}>
            {saving
              ? zh
                ? "保存中…"
                : "Saving…"
              : zh
                ? "保存 Agent 能力设置"
                : "Save agent capability settings"}
          </Button>
          {saved && (
            <span role="status" className="text-xs text-muted-foreground">
              {zh ? "已保存" : "Saved"}
            </span>
          )}
        </div>
      </form>
    </SettingsCard>
  );
}
