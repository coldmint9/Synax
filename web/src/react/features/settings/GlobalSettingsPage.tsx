import { InputOptimizationSettings } from "./components/InputOptimizationSettings";
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useShellStore } from "../../state/shellStore";
import { SettingsFrame, type SettingsSection } from "./extensions/SettingsFrame";
import { ExtensionCenter } from "./extensions/ExtensionCenter";
import { useExtensionCopy } from "./extensions/extension-copy";
import { ScrollShadow, Spinner, Typography } from "@heroui/react";
import { useConfig } from "./useConfig";
import { useLocale } from "../../../hooks/useLocale";
import { AppearanceSection } from "./components/AppearanceSection";
import { LayoutSection } from "./components/LayoutSection";
import { TerminalSettings } from "./components/TerminalSettings";
import { LlmProviderSection } from "./components/LlmProviderSection";
import { WikiModelSettings } from "./components/WikiModelSettings";
import { OpenConfigFile } from "./components/OpenConfigFile";
import { WebSearchSettings } from "./components/WebSearchSettings";
import { UpdateSettings } from "./components/UpdateSettings";
import { SessionArchiveSettings } from "./components/SessionArchiveSettings";

export default function GlobalSettingsPage() {
  const { globalConfig, providers, reload, updateGlobalConfig } = useConfig();
  const { t } = useLocale();
  const copy = useExtensionCopy();
  const projectId = useShellStore(state => state.currentProjectId);
  const [params, setParams] = useSearchParams();
  const selected = params.get('section') ?? 'general';
  const section: SettingsSection = ['archive', 'tool', 'skill', 'mcp', 'market'].includes(selected) ? selected as SettingsSection : 'general';
  const select = (value: SettingsSection) => setParams(previous => { const next = new URLSearchParams(previous); next.set('section', value); return next; });

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [reload]);

  // Background refreshes must preserve open dialogs and their unsaved input.
  if (!globalConfig) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="sm" />
      </div>
    );
  }

  return (
    <ScrollShadow className="settings-scroll-viewport">
      <div className="settings-scroll-content">
        <SettingsFrame section={section} onSelect={select} projectId={projectId}>
          {section === "archive" ? (
            <SessionArchiveSettings config={globalConfig} onUpdate={updateGlobalConfig} />
          ) : section !== "general" ? (projectId ? <ExtensionCenter key={`${projectId}:${section}`} projectId={projectId} section={section} onNavigate={select} /> : <p className="extension-project-hint">{copy.pickProject}</p>) : <>
          <div className="mb-8">
            <Typography type="h5">{t("settingsSystemConfig")}</Typography>
            <Typography type="body-sm" color="muted" className="mt-1">
              {t("settingsTitle")}
            </Typography>
          </div>

          <div className="space-y-8">
            <AppearanceSection />
            <LayoutSection />
            <UpdateSettings />
            <TerminalSettings
              configuredPath={globalConfig.terminalShellPath}
              onUpdate={updateGlobalConfig}
            />
            <LlmProviderSection
              config={globalConfig}
              providers={providers}
              onUpdate={updateGlobalConfig}
              onReload={reload}
            />
            <InputOptimizationSettings
              config={globalConfig}
              onUpdate={updateGlobalConfig}
            />
            <WikiModelSettings
              config={globalConfig}
              onUpdate={updateGlobalConfig}
            />
            <WebSearchSettings
              config={globalConfig}
              onUpdate={updateGlobalConfig}
              onReload={reload}
            />
          </div>
          <OpenConfigFile />
          </>}
        </SettingsFrame>
      </div>
    </ScrollShadow>
  );
}
