import { FileOpenerSelect } from "./FileOpenerSelect";
import { Switch } from "@/shared/ui/ui/Toggle";
import { SlidersHorizontal } from "lucide-react";
import { useShellStore } from "../../../shared/state/shellStore";
import { useLocale } from "../../../shared/hooks/useLocale";
import { SettingsCard } from "./SettingsCard";
import { SettingsSelect } from "./SettingsSelect";
import { FormRow } from "./FormRow";

export function LayoutSection() {
  const { t, locale } = useLocale();
  const zh = locale === "zh";
  const defaultHome = useShellStore((s) => s.preferences.defaultHome);
  const notifications = useShellStore((s) => s.preferences.notifications);
  const foldWorkRuns = useShellStore((s) => s.preferences.sessionFoldWorkRuns);
  const showThinking = useShellStore((s) => s.preferences.sessionShowThinking);
  const agentFontSize = useShellStore((s) => s.preferences.agentFontSize);
  const userMessageFontWeight = useShellStore(
    (s) => s.preferences.userMessageFontWeight,
  );
  const setLocale = useShellStore((s) => s.setLocale);
  const setDefaultHome = useShellStore((s) => s.setDefaultHome);
  const setNotifications = useShellStore((s) => s.setNotifications);
  const setFoldWorkRuns = useShellStore((s) => s.setSessionFoldWorkRuns);
  const setShowThinking = useShellStore((s) => s.setSessionShowThinking);
  const setAgentFontSize = useShellStore((s) => s.setAgentFontSize);
  const setUserMessageFontWeight = useShellStore(
    (s) => s.setUserMessageFontWeight,
  );

  return (
    <SettingsCard title={t("settingsLayoutTitle")} icon={SlidersHorizontal}>
      <div className="settings-rows settings-rows--split">
        <FormRow label={t("settingsLanguage")}>
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

        <FormRow label={zh ? "界面字体大小" : "Interface font size"}>
          <SettingsSelect
            className="w-32 max-w-full"
            selectedKey={String(agentFontSize)}
            onSelectionChange={(key) => {
              if (key) setAgentFontSize(Number(key));
            }}
            disallowEmptySelection
            aria-label={zh ? "界面字体大小" : "Interface font size"}
            options={[12, 13, 14, 15, 16, 18, 20].map((size) => ({
              key: String(size),
              label: `${size}px${size === 14 ? (zh ? "（默认）" : " (default)") : ""}`,
            }))}
          />
        </FormRow>

        <FormRow
          label={t("settingsShowThinking")}
          description={t("settingsShowThinkingHint")}
        >
          <Switch
            size="sm"
            checked={showThinking}
            onChange={setShowThinking}
            aria-label={t("settingsShowThinking")}
          />
        </FormRow>

        <FormRow label={zh ? "用户消息字重" : "Message font weight"}>
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
              aria-label={zh ? "用户消息字重" : "Message font weight"}
              className="min-w-0 flex-1"
            />
            <output className="w-8 text-right text-xs tabular-nums text-muted-foreground">
              {userMessageFontWeight}
            </output>
          </div>
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

        <FormRow label={t("settingsEditor")}>
          <FileOpenerSelect />
        </FormRow>

        <FormRow label={t("settingsDefaultHome")}>
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
      </div>
    </SettingsCard>
  );
}
