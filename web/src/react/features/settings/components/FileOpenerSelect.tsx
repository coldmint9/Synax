import { useEffect, useState } from "react";
import { AppWindow } from "lucide-react";
import { configApi, type FileOpener } from "../../../../lib/api/config";
import { useShellStore } from "../../../state/shellStore";
import { useLocale } from "../../../../hooks/useLocale";
import { SettingsSelect, type SelectOption } from "./SettingsSelect";

export function FileOpenerSelect() {
  const { locale, t } = useLocale();
  const selected = useShellStore((s) => s.preferences.editor);
  const setEditor = useShellStore((s) => s.setEditor);
  const [apps, setApps] = useState<FileOpener[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    configApi
      .listFileOpeners()
      .then(({ apps }) => {
        if (active) setApps(apps);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [retry]);
  const missing =
    !loading && !error && !apps.some((app) => app.id === selected);
  const options: SelectOption[] = (
    apps.length ? apps : [{ id: "system", name: "System default", icon: null }]
  ).map((app) => {
    const name = app.id === "system" && locale === "zh" ? "系统默认" : app.name;
    return {
      key: app.id,
      textValue: name,
      label: (
        <span className="settings-app-option">
          {app.icon?.startsWith("data:image/png;base64,") ? (
            <img src={app.icon} alt="" width={18} height={18} />
          ) : (
            <AppWindow size={18} aria-hidden="true" />
          )}
          <span>{name}</span>
        </span>
      ),
    };
  });
  if (!options.some((option) => option.key === selected)) {
    options.push({
      key: selected,
      textValue: selected,
      isDisabled: true,
      label: <span>{selected}</span>,
    });
  }
  return (
    <div className="settings-file-opener">
      <SettingsSelect
        selectedKey={selected}
        onSelectionChange={(key) => {
          if (key) setEditor(key);
        }}
        aria-label={t("settingsEditor")}
        isDisabled={loading}
        options={options}
      />
      {loading && (
        <span role="status" className="settings-opener-status">
          {locale === "zh" ? "正在检测本机应用…" : "Detecting host apps…"}
        </span>
      )}
      {missing && (
        <span role="status" className="settings-opener-status">
          {locale === "zh"
            ? "所选应用不可用，打开时将使用系统默认。"
            : "Selected app unavailable; will use system default."}
        </span>
      )}
      {error && (
        <button
          type="button"
          className="settings-opener-status"
          onClick={() => setRetry((value) => value + 1)}
        >
          {locale === "zh" ? "检测失败，点击重试" : "Detection failed. Retry"}
        </button>
      )}
    </div>
  );
}
