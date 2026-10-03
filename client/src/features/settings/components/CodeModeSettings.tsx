import { useEffect, useState } from "react";
import { Switch } from "@headlessui/react";
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
  const [enabled, setEnabled] = useState(value?.enabled ?? false);
  const [mcp, setMcp] = useState((value?.mcpTools ?? []).join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setEnabled(value?.enabled ?? false);
    setMcp((value?.mcpTools ?? []).join("\n"));
  }, [value]);
  const dirty =
    enabled !== (value?.enabled ?? false) ||
    mcp !== (value?.mcpTools ?? []).join("\n");
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
      await onSave({ enabled, mcpTools });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsCard
      title="Code Mode"
      icon={Code2}
      description={
        zh ? "只读编排 · 按项目启用" : "Read-only composition · Per project"
      }
    >
      <form
        className="grid min-w-0 gap-5 p-4 sm:p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field disabled={saving} className="grid-cols-[1fr_auto] items-center">
          <div className="grid gap-1.5">
            <Label>{zh ? "启用 Code Mode" : "Enable Code Mode"}</Label>
            <Description>
              {zh
                ? "让原生 Synax 代理用隔离 JavaScript 批量读取、搜索和汇总。默认关闭，直接工具调用不受影响。"
                : "Let the native Synax agent compose reads, searches and summaries in isolated JavaScript. Off by default; direct tools are unchanged."}
            </Description>
          </div>
          <Switch
            checked={enabled}
            onChange={(checked) => {
              setEnabled(checked);
              setSaved(false);
            }}
            className="group relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full bg-muted transition-colors data-checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span
              aria-hidden="true"
              className="size-4 translate-x-1 rounded-full bg-background shadow transition-transform group-data-checked:translate-x-6"
            />
          </Switch>
        </Field>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {zh
            ? "每次最多 15 秒、32 次调用、4 路并发。无 Shell、写文件或直接网络访问；需要审批的操作请使用直接工具。运维可通过 SYNAX_CODE_MODE=0 全局关闭。"
            : "Up to 15 seconds, 32 calls and 4 concurrent calls per execution. No Shell, writes or direct network access. Use direct tools for approvals. Operators can disable globally with SYNAX_CODE_MODE=0."}
        </p>
        <Field disabled={saving || !enabled}>
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
                ? "保存 Code Mode 设置"
                : "Save Code Mode settings"}
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
