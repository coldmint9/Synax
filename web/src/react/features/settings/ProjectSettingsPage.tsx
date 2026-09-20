import { Button, ScrollShadow, Spinner, Typography } from "@heroui/react";
import { useParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { useProjectSettings } from "./useProjectSettings";
import { useConfig } from "./useConfig";
import { useLocale } from "../../../hooks/useLocale";
import { ProjectCapabilitiesSection } from "./integrations/ProjectCapabilitiesSection";
import type { I18nKey } from "../../../lib/i18n";
import { SettingsCard } from "./components/SettingsCard";
import { GitWorktreesSection } from "./components/GitWorktreesSection";
import { ProjectReferencesSection } from "./components/ProjectReferencesSection";

function ComingSoon({ titleKey }: { titleKey: I18nKey }) {
  const { t } = useLocale();
  return (
    <SettingsCard title={t(titleKey)}>
      <p className="settings-note">{t("settingsComingSoon")}</p>
    </SettingsCard>
  );
}

function ProviderTab(_props: {
  settings: any;
  globalConfig: any;
  providers: any;
  onSave: (data: any) => void;
}) {
  return <ComingSoon titleKey="settingsTabProvider" />;
}
function BasicsTab(_props: { settings: any; onSave: (data: any) => void }) {
  return <ComingSoon titleKey="settingsTabBasics" />;
}
function CollaborationTab(_props: {
  settings: any;
  onSave: (data: any) => void;
}) {
  return <ComingSoon titleKey="settingsTabCollaboration" />;
}
function NotificationsTab(_props: {
  settings: any;
  onSave: (data: any) => void;
}) {
  return <ComingSoon titleKey="settingsTabNotifications" />;
}
function ComplianceTab(_props: { settings: any; onSave: (data: any) => void }) {
  return <ComingSoon titleKey="settingsTabCompliance" />;
}

export default function ProjectSettingsPage() {
  const { projectId = "" } = useParams();
  return <ProjectSettingsContent key={projectId} projectId={projectId} />;
}

function ProjectSettingsContent({ projectId }: { projectId: string }) {
  const { settings, loading, error, reload, patchSection } =
    useProjectSettings(projectId);
  const { globalConfig, providers } = useConfig(projectId);
  const { t } = useLocale();

  if (!projectId)
    return (
      <div className="p-6 text-sm text-destructive">
        {t("settingsMissingProjectId")}
      </div>
    );

  if (error) {
    return (
      <div className="space-y-3 p-6">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <Button size="sm" variant="outline" onPress={reload}>
          {t("settingsRefresh")}
        </Button>
      </div>
    );
  }

  if (loading || !settings) {
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
          <div className="flex items-start justify-between gap-3 mb-8">
            <div>
              <Typography type="h5">{t("settingsProjectTitle")}</Typography>
              <Typography
                type="body-xs"
                color="muted"
                className="mt-1 font-mono"
              >
                {projectId}
              </Typography>
            </div>
            <Button
              size="sm"
              variant="outline"
              isIconOnly
              onPress={reload}
              aria-label={t("settingsRefresh")}
            >
              <RefreshCw size={12} />
            </Button>
          </div>

          <div className="space-y-8">
            <ProjectReferencesSection projectId={projectId} />
            <ProviderTab
              settings={settings}
              globalConfig={globalConfig}
              providers={providers}
              onSave={(data) => patchSection("provider", data)}
            />
            <ProjectCapabilitiesSection
              projectId={projectId}
              servers={settings.mcpServers}
              onSave={async (servers) => {
                await patchSection("mcp", { mcpServers: servers });
              }}
            />
            <GitWorktreesSection projectId={projectId} />
            <BasicsTab
              settings={settings}
              onSave={(data) => patchSection("basics", data)}
            />
            <CollaborationTab
              settings={settings}
              onSave={(data) => patchSection("collaboration", data)}
            />
            <NotificationsTab
              settings={settings}
              onSave={(data) => patchSection("notifications", data)}
            />
            <ComplianceTab
              settings={settings}
              onSave={(data) => patchSection("compliance", data)}
            />
          </div>
        </div>
      </div>
    </ScrollShadow>
  );
}
