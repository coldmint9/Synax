import { FileOpenerSelect } from "./FileOpenerSelect";
import { Switch } from "@/react/components/ui/Toggle";
import { SlidersHorizontal } from "lucide-react";
import { useShellStore } from "../../../state/shellStore";
import { useLocale } from "../../../../hooks/useLocale";
import { SettingsCard } from "./SettingsCard";
import { SettingsSelect } from "./SettingsSelect";
import { FormRow } from "./FormRow";

export function LayoutSection() {
  const { t } = useLocale();
  const wikiEnabled = useShellStore((s) => s.preferences.wikiEnabled);
  const setWikiEnabled = useShellStore((s) => s.setWikiEnabled);
  const locale = useShellStore((s) => s.preferences.locale);
  const defaultHome = useShellStore((s) => s.preferences.defaultHome);
  const notifications = useShellStore((s) => s.preferences.notifications);
  const foldWorkRuns = useShellStore((s) => s.preferences.sessionFoldWorkRuns);
  const agentFontSize = useShellStore((s) => s.preferences.agentFontSize);
  const userMessageFontWeight = useShellStore(
    (s) => s.preferences.userMessageFontWeight,
  );
  const setLocale = useShellStore((s) => s.setLocale);
  const setDefaultHome = useShellStore((s) => s.setDefaultHome);
  const setNotifications = useShellStore((s) => s.setNotifications);
  const setFoldWorkRuns = useShellStore((s) => s.setSessionFoldWorkRuns);
  const setAgentFontSize = useShellStore((s) => s.setAgentFontSize);
  const setUserMessageFontWeight = useShellStore(
    (s) => s.setUserMessageFontWeight,
  );

  return (
    <SettingsCard title={t("settingsLayoutTitle")} icon={SlidersHorizontal}>
      <div className="settings-rows">
        <FormRow
          label={t("settingsLanguage")}
          description={t("settingsLanguageHint")}
        >
          <SettingsSelect
            className="w-32 max-w-full"
            selectedKey={locale}
            onSelectionChange={(key) => {
              if (key) setLocale(key as "zh" | "en");
            }}
            disallowEmptySelection
            aria-label={t("settingsLanguage")}
            options={[
              { key: "zh", label: "中文" },
              { key: "en", label: "English" },
            ]}
          />
        </FormRow>

        <FormRow
          label={t("settingsDefaultHome")}
          description={t("settingsDefaultHomeHint")}
        >
          <SettingsSelect
            className="w-32 max-w-full"
            selectedKey={defaultHome}
            onSelectionChange={(key) => {
              if (key) setDefaultHome(key as "global-home" | "last-project");
            }}
            disallowEmptySelection
            aria-label={t("settingsDefaultHome")}
            options={[
              { key: "global-home", label: t("settingsGlobalHome") },
              { key: "last-project", label: t("settingsLastProject") },
            ]}
          />
        </FormRow>

        <FormRow
          label={t("settingsNotifications")}
          description={t("settingsNotificationsHint")}
        >
          <Switch
            size="sm"
            checked={notifications}
            onChange={setNotifications}
            aria-label={t("settingsNotifications")}
          />
        </FormRow>

        <FormRow
          label={t("sessionWorkLogToggle")}
          description={t("settingsFoldWorkLogHint")}
        >
          <Switch
            size="sm"
            checked={foldWorkRuns}
            onChange={setFoldWorkRuns}
            aria-label={t("sessionWorkLogToggle")}
          />
        </FormRow>

        <FormRow
          label="界面字体大小"
          description="调整 Synax 所有界面文字大小，默认 14px"
        >
          <SettingsSelect
            className="w-32 max-w-full"
            selectedKey={String(agentFontSize)}
            onSelectionChange={(key) => {
              if (key) setAgentFontSize(Number(key));
            }}
            disallowEmptySelection
            aria-label="界面字体大小"
            options={[12, 13, 14, 15, 16, 18, 20].map((size) => ({
              key: String(size),
              label: `${size}px${size === 14 ? "（默认）" : ""}`,
            }))}
          />
        </FormRow>

        <FormRow
          label="用户消息字重"
          description="调整 island 对话页用户消息框的字体粗细，默认 450"
        >
          <div className="flex w-44 items-center gap-2">
            <input
              type="range"
              min={100}
              max={900}
              step={1}
              value={userMessageFontWeight}
              onChange={(event) =>
                setUserMessageFontWeight(Number(event.target.value))
              }
              aria-label="用户消息字重"
              className="min-w-0 flex-1"
            />
            <output className="w-8 text-right text-xs tabular-nums text-muted-foreground">
              {userMessageFontWeight}
            </output>
          </div>
        </FormRow>

        <FormRow
          label={locale === "zh" ? "Wiki（实验性功能）" : "Wiki (Experimental)"}
          description={
            locale === "zh"
              ? "开启 Wiki 文档与规划功能。实验性功能仍在完善中，默认关闭。"
              : "Enable Wiki documents and planning. This experimental feature is still in development and is off by default."
          }
        >
          <Switch
            size="sm"
            checked={wikiEnabled}
            onChange={setWikiEnabled}
            aria-label="Wiki"
          />
        </FormRow>

        <FormRow
          label={t("settingsEditor")}
          description={t("settingsEditorHint")}
        >
          <FileOpenerSelect />
        </FormRow>
      </div>
    </SettingsCard>
  );
}
