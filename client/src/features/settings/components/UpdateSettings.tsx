import { useEffect, useState } from "react";
import { Spinner } from "@/shared/ui/ui/Display";
import { Button } from "@/shared/ui/ui/Button";
import { Switch } from "@/shared/ui/ui/Toggle";
import { InfoTooltip } from "@/shared/ui/ui/InfoTooltip";
import { Download, Save, RotateCw } from "lucide-react";
import { useLocale } from "../../../shared/hooks/useLocale";
import {
  getDesktopUpdateSettingsApi,
  type DesktopUpdateSettingsApi,
  type UpdateSettings,
} from "../../../adapters/electron/desktop-update-settings";
import { SettingsCard } from "./SettingsCard";
import { SettingsSelect } from "./SettingsSelect";
import { DesktopUpdateStatus } from "../../updates/DesktopUpdateStatus";

export function UpdateSettings() {
  const api = getDesktopUpdateSettingsApi();
  if (!api) return null;
  return <DesktopUpdateSettingsCard api={api} />;
}

function DesktopUpdateSettingsCard({ api }: { api: DesktopUpdateSettingsApi }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [settings, setSettings] = useState<UpdateSettings | null>(null);
  const [draft, setDraft] = useState<UpdateSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setError(null);
    void api
      .getUpdateSettings()
      .then((value) => {
        if (!current) return;
        setSettings(value);
        setDraft(value);
      })
      .catch((error) => {
        if (current)
          setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      current = false;
    };
  }, [api, attempt]);

  const changed =
    draft &&
    settings &&
    (draft.enabled !== settings.enabled ||
      draft.sourceUrl.trim() !== settings.sourceUrl ||
      draft.mode !== settings.mode ||
      (draft.mode === "custom" &&
        draft.customProxyUrl.trim() !== settings.customProxyUrl));

  const save = async () => {
    if (!draft || !settings || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await api.setUpdateSettings({
        enabled: draft.enabled,
        sourceUrl: draft.sourceUrl.trim(),
        mode: draft.mode,
        customProxyUrl:
          draft.mode === "custom"
            ? draft.customProxyUrl.trim()
            : settings.customProxyUrl,
      });
      setSettings(result);
      setDraft(result);
      setSaved(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard title={zh ? "在线更新" : "Online updates"} icon={Download}>
      <form
        className="space-y-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {!draft && !error && (
          <Spinner
            size="sm"
            aria-label={zh ? "加载更新设置" : "Loading update settings"}
          />
        )}
        {draft && (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium">
                {zh ? "启用在线更新" : "Enable online updates"}
              </span>
              <Switch
                size="sm"
                checked={draft.enabled}
                disabled={saving}
                aria-label={zh ? "启用在线更新" : "Enable online updates"}
                onChange={(enabled) => {
                  setDraft({ ...draft, enabled });
                  setSaved(false);
                  setError(null);
                }}
              />
            </div>
            {draft.enabled && (
              <>
                <label className="block text-xs">
                  <span className="flex items-center gap-1">
                    {zh ? "更新源地址（HTTPS）" : "Update source (HTTPS)"}
                    <InfoTooltip
                      label={zh ? "更新源说明" : "About the update source"}
                    >
                      {zh
                        ? "留空时使用安装包内置或环境变量指定的更新源。"
                        : "Leave empty to use the source built into the installer or the environment."}
                    </InfoTooltip>
                  </span>
                  <input
                    type="url"
                    maxLength={2048}
                    className="mt-2 w-full rounded-lg border border-border bg-transparent px-3 py-2 font-mono text-xs"
                    value={draft.sourceUrl}
                    disabled={saving}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="https://updates.example.com/synax/"
                    onChange={(event) => {
                      setDraft({ ...draft, sourceUrl: event.target.value });
                      setSaved(false);
                      setError(null);
                    }}
                  />
                </label>
                <SettingsSelect
                  label={zh ? "更新连接方式" : "Update connection"}
                  selectedKey={draft.mode}
                  isDisabled={saving}
                  disallowEmptySelection
                  fullWidth
                  options={[
                    { key: "direct", label: zh ? "直连" : "Direct" },
                    { key: "gh-proxy", label: "GH-Proxy" },
                    { key: "custom", label: zh ? "自定义代理" : "Custom proxy" },
                  ]}
                  onSelectionChange={(mode) => {
                    if (
                      mode !== "direct" &&
                      mode !== "gh-proxy" &&
                      mode !== "custom"
                    )
                      return;
                    setDraft({ ...draft, mode });
                    setError(null);
                    setSaved(false);
                  }}
                />
                {draft.mode === "gh-proxy" && (
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    https://gh-proxy.org/
                  </p>
                )}
                {draft.mode === "custom" && (
                  <label className="block text-xs">
                    {zh ? "代理 URL 前缀（HTTPS）" : "Proxy URL prefix (HTTPS)"}
                    <input
                      type="url"
                      required
                      maxLength={2048}
                      className="mt-2 w-full rounded-lg border border-border bg-transparent px-3 py-2 font-mono text-xs"
                      value={draft.customProxyUrl}
                      disabled={saving}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="https://proxy.example.com/"
                      onChange={(event) => {
                        setDraft({
                          ...draft,
                          customProxyUrl: event.target.value,
                        });
                        setSaved(false);
                        setError(null);
                      }}
                    />
                  </label>
                )}
                {draft.mode !== "direct" && (
                  <p className="text-xs text-muted-foreground">
                    {zh
                      ? "第三方代理可读取并修改更新内容，请仅使用可信服务。"
                      : "Third-party proxies can read and modify update content. Use a trusted service."}
                  </p>
                )}
              </>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="break-words text-xs text-danger">
            {error}
          </p>
        )}
        {saved && (
          <p role="status" className="text-xs text-success">
            {zh ? "已保存" : "Saved"}
          </p>
        )}
        {draft ? (
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={saving || !changed}
            aria-label={zh ? "保存更新设置" : "Save update settings"}
          >
            <Save size={14} />
            {saving ? (zh ? "保存中…" : "Saving…") : zh ? "保存" : "Save"}
          </Button>
        ) : error ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RotateCw size={14} />
            {zh ? "重试" : "Retry"}
          </Button>
        ) : null}
      </form>
      {settings?.enabled && (
        <DesktopUpdateStatus className="border-t border-border p-4" />
      )}
    </SettingsCard>
  );
}
