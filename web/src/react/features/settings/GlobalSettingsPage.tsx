import { useEffect } from "react";
import { ScrollShadow, Spinner, Typography } from "@heroui/react";
import { useConfig } from "./useConfig";
import { useLocale } from "../../../hooks/useLocale";
import { AppearanceSection } from "./components/AppearanceSection";
import { LayoutSection } from "./components/LayoutSection";
import { TerminalSettings } from "./components/TerminalSettings";
import { LlmProviderSection } from "./components/LlmProviderSection";
import { WikiModelSettings } from "./components/WikiModelSettings";
import { OpenConfigFile } from "./components/OpenConfigFile";
import { ProjectIntegrationsSection } from "./components/ProjectIntegrationsSection";
import { WebSearchSettings } from "./components/WebSearchSettings";
import { UpdateSettings } from "./components/UpdateSettings";

export default function GlobalSettingsPage() {
  const { globalConfig, providers, reload, updateGlobalConfig } = useConfig();
  const { t } = useLocale();

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
        <div className="mx-auto max-w-5xl px-6 pt-16 pb-16">
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
          <ProjectIntegrationsSection />
          <OpenConfigFile />
        </div>
      </div>
    </ScrollShadow>
  );
}
