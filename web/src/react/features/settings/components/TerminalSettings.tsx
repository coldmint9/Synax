import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { Terminal } from "lucide-react";
import { configApi } from "../../../../lib/api/config";
import type { UpdateGlobalConfigRequest } from "../../../../lib/contracts/config";
import { useLocale } from "../../../../hooks/useLocale";
import { SettingsCard } from "./SettingsCard";

export function TerminalSettings({
  configuredPath = "",
  onUpdate,
}: {
  configuredPath?: string;
  onUpdate: (patch: UpdateGlobalConfigRequest) => Promise<void>;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [draft, setDraft] = useState(configuredPath);
  const [defaultPath, setDefaultPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setDraft(configuredPath);
  }, [configuredPath]);
  useEffect(() => {
    let current = true;
    void configApi
      .getTerminalShell()
      .then((result) => {
        if (current) setDefaultPath(result.defaultPath);
      })
      .catch((err) => {
        if (current) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      current = false;
    };
  }, []);
  const save = async (value: string) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await onUpdate({ terminalShellPath: value.trim() });
      setDraft(value.trim());
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsCard
      title={zh ? "原生终端" : "Native terminal"}
      icon={Terminal}
      description={
        zh
          ? "设置新建本地终端使用的 Shell，已打开的终端不受影响。WSL 终端使用发行版内的 Shell。"
          : "Choose the shell for new local terminals. Existing terminals are unchanged; WSL uses its own shell."
      }
    >
      <form
        className="space-y-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save(draft);
        }}
      >
        <label className="block text-xs">
          {zh ? "Shell 可执行文件路径" : "Shell executable path"}
          <input
            className="mt-2 w-full rounded-lg border border-border bg-transparent px-3 py-2 font-mono text-xs"
            value={draft}
            disabled={saving}
            spellCheck={false}
            placeholder={
              defaultPath ??
              (zh ? "留空使用系统默认" : "Leave empty for system default")
            }
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          {zh
            ? "填写可执行文件的绝对路径，不含命令参数；留空使用系统默认。"
            : "Enter an absolute executable path without arguments, or leave empty for system default."}
        </p>
        <div
          className="space-y-1 text-xs text-muted-foreground"
          aria-live="polite"
        >
          <p>
            {zh ? "当前配置：" : "Configured: "}
            <code className="break-all">
              {configuredPath || (zh ? "系统默认" : "System default")}
            </code>
          </p>
          <p>
            {zh ? "当前生效路径：" : "Effective path: "}
            <code className="break-all">
              {configuredPath ||
                defaultPath ||
                (zh ? "尚未获取" : "Unavailable")}
            </code>
          </p>
        </div>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        {saved && (
          <p role="status" className="text-xs text-success">
            {zh
              ? "已保存，下次新建终端时生效。"
              : "Saved. Applies to new terminals."}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            type="submit"
            aria-label={zh ? "保存终端路径" : "Save terminal path"}
            size="sm"
            variant="secondary"
            isDisabled={saving || draft.trim() === configuredPath}
          >
            {saving ? (zh ? "保存中…" : "Saving…") : zh ? "保存" : "Save"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="tertiary"
            isDisabled={saving || !configuredPath}
            onPress={() => void save("")}
          >
            {zh ? "恢复系统默认" : "Use system default"}
          </Button>
        </div>
      </form>
    </SettingsCard>
  );
}
