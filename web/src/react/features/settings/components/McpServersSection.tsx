import { useEffect, useRef, useState } from "react";
import { Button, Switch, Modal } from "@heroui/react";
import { Loader2, Plug, Plus, Wifi } from "lucide-react";
import { ExtensionControls } from '../../../components/extensions/ExtensionControls';
import { UninstallDialog } from '../../../components/extensions/UninstallDialog';
import { SettingsCard } from "./SettingsCard";
import { SaveIndicator } from "./SaveIndicator";
import { configApi } from "../../../../lib/api/config";
import type {
  GlobalConfig,
  McpServerConfig,
} from "../../../../lib/contracts/config";
import { useLocale } from "../../../../hooks/useLocale";

interface Props {
  projectId?: string;
  /** Global settings mode (legacy/administrative use). */
  config?: GlobalConfig;
  /** Project settings mode. */
  servers?: McpServerConfig[];
  onUpdate?: (patch: Record<string, unknown>) => Promise<void>;
  onSave?: (servers: McpServerConfig[]) => Promise<void>;
  title?: string;
  description?: string;
}

type Draft = {
  id: string;
  name: string;
  command: string;
  cwd: string;
  argsText: string;
  envText: string;
  enabled: boolean;
};

function emptyDraft(id: string): Draft {
  return {
    id,
    name: "",
    command: "",
    cwd: "",
    argsText: "",
    envText: "",
    enabled: true,
  };
}

function draftToConfig(draft: Draft): McpServerConfig {
  const args = draft.argsText
    .split("\n")
    .map((a) => a.trim())
    .filter(Boolean);
  const env: Record<string, string> = {};
  for (const line of draft.envText.split("\n")) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) env[key] = value;
  }
  return {
    id: draft.id,
    name: draft.name.trim(),
    command: draft.command.trim(),
    ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(draft.enabled ? {} : { enabled: false }),
  };
}

function configToDraft(server: McpServerConfig): Draft {
  return {
    id: server.id,
    name: server.name,
    command: server.command,
    cwd: server.cwd ?? "",
    argsText: (server.args ?? []).join("\n"),
    envText: Object.entries(server.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    enabled: server.enabled !== false,
  };
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return `mcp-${crypto.randomUUID().slice(0, 8)}`;
  return `mcp-${Date.now().toString(36)}`;
}

export function McpServersSection({
  projectId,
  config,
  servers: initialServers,
  onUpdate,
  onSave,
  title,
  description,
}: Props) {
  const { t } = useLocale();
  const [servers, setServers] = useState<McpServerConfig[]>(
    initialServers ?? config?.mcpServers ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const activeProjectRef = useRef(projectId);
  const savingRef = useRef(false);
  const [pendingUninstall, setPendingUninstall] = useState<McpServerConfig | null>(null);

  useEffect(() => {
    setServers(initialServers ?? config?.mcpServers ?? []);
  }, [config?.mcpServers, initialServers]);
  useEffect(() => {
    activeProjectRef.current = projectId;
    setSaving(false);
    savingRef.current = false;
    setEditing(null);
    setPendingUninstall(null);
    setSaveError(null);
    setTestMessages({});
  }, [projectId]);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testMessages, setTestMessages] = useState<Record<string, string>>({});

  async function persist(
    next: McpServerConfig[],
    expectedProjectId = activeProjectRef.current,
  ): Promise<boolean> {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      if (onSave) await onSave(next);
      else if (onUpdate) await onUpdate({ mcpServers: next });
      if (activeProjectRef.current !== expectedProjectId) return false;
      setServers(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
      return true;
    } catch (err) {
      if (activeProjectRef.current !== expectedProjectId) return false;
      setSaveError(
        err instanceof Error ? err.message : t("settingsMcpSaveFailed"),
      );
      return false;
    } finally {
      if (activeProjectRef.current === expectedProjectId) { savingRef.current = false; setSaving(false); }
    }
  }

  async function handleTest(server: McpServerConfig) {
    setTestingId(server.id);
    setTestMessages((m) => ({ ...m, [server.id]: t("settingsMcpConnecting") }));
    try {
      const result = await configApi.testMcpServer(server);
      if (result.ok) {
        setTestMessages((m) => ({
          ...m,
          [server.id]: t("settingsMcpConnectedTools", {
            count: result.tools.length,
            tools:
              result.tools
                .slice(0, 8)
                .map((tool) => tool.name)
                .join(", ") || "—",
          }),
        }));
      } else {
        setTestMessages((m) => ({
          ...m,
          [server.id]: `✗ ${result.error ?? t("settingsMcpConnectionFailed")}`,
        }));
      }
    } catch (err) {
      setTestMessages((m) => ({
        ...m,
        [server.id]: `✗ ${err instanceof Error ? err.message : t("settingsMcpConnectionFailed")}`,
      }));
    } finally {
      setTestingId(null);
    }
  }

  function handleToggleEnabled(server: McpServerConfig, enabled: boolean) {
    const next = servers.map((s) =>
      s.id === server.id ? { ...s, enabled } : s,
    );
    void persist(next);
  }

  async function handleSaveDraft() {
    if (!editing) return;
    if (!editing.name.trim() || !editing.command.trim()) {
      setSaveError(t("settingsMcpNameCommandRequired"));
      return;
    }
    const configDraft = draftToConfig(editing);
    const next = servers.some((s) => s.id === editing.id)
      ? servers.map((s) => (s.id === editing.id ? configDraft : s))
      : [...servers, configDraft];
    if (await persist(next)) setEditing(null);
  }

  async function handleDelete(id: string) {
    if (await persist(servers.filter((s) => s.id !== id))) {
      setPendingUninstall(null);
      if (editing?.id === id) setEditing(null);
    }
  }

  return (
    <SettingsCard
      title={title ?? t("settingsMcpTitle")}
      icon={Plug}
      trailing={
        <div className="flex items-center gap-2">
          <SaveIndicator saving={saving} saved={saved} error={saveError} />
          <Button
            size="sm"
            variant="secondary"
            isDisabled={saving}
            onPress={() => {
              setSaveError(null);
              setEditing(emptyDraft(randomId()));
            }}
          >
            <Plus size={12} />
            {t("settingsMcpAddServer")}
          </Button>
        </div>
      }
    >
      <p className="settings-note">{description ?? t("settingsMcpDesc")}</p>
      {servers.length === 0 && !editing && (
        <p className="settings-note">{t("settingsMcpEmpty")}</p>
      )}
      <div className="settings-list">
        {servers.map((server) => (
          <div key={server.id} className="settings-item overflow-hidden">
            <div className="flex min-h-[76px] items-center gap-3 px-4 py-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Plug size={17} /></div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground" title={server.name}>{server.name}</p>
                <p className="mt-1 truncate font-mono text-xs leading-5 text-muted-foreground" title={`${server.command} ${server.args?.join(' ') ?? ''}`}>
                  {server.command} {server.args?.join(' ') ?? ''}
                </p>
                {testMessages[server.id] && <p role="status" className="mt-1 text-xs leading-5 text-muted-foreground">{testMessages[server.id]}</p>}
              </div>
              <ExtensionControls name={server.name} enabled={server.enabled !== false} busy={saving}
                onToggle={(enabled) => handleToggleEnabled(server, enabled)}
                actions={[
                  { id: 'edit', label: t('settingsMcpEdit'), onAction: () => { setEditing(configToDraft(server)); setSaveError(null); } },
                  { id: 'test', label: t(testingId === server.id ? 'settingsMcpConnecting' : 'settingsMcpTest'), disabled: testingId !== null, onAction: () => void handleTest(server) },
                  { id: 'uninstall', label: t('settingsMcpDelete'), danger: true, onAction: () => { setSaveError(null); setPendingUninstall(server); } },
                ]} />
            </div>
          </div>
        ))}
      </div>

      <UninstallDialog name={pendingUninstall?.name ?? null} description={t('mcpUninstallHint')}
        busy={saving} error={saveError} onCancel={() => setPendingUninstall(null)}
        onConfirm={() => { if (pendingUninstall) void handleDelete(pendingUninstall.id); }} />
      <Modal
        isOpen={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open && !saving) setEditing(null);
        }}
      >
        <Modal.Backdrop>
          <Modal.Container size="lg">
            <Modal.Dialog>
              {editing && (
                <>
                  <Modal.Header>
                    <Modal.Heading>
                      {servers.some((s) => s.id === editing.id)
                        ? t("settingsMcpEditTitle")
                        : t("settingsMcpAddTitle")}
                    </Modal.Heading>
                  </Modal.Header>
                  <Modal.Body>
                    <fieldset disabled={saving} className="space-y-3">
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium text-foreground">
                          {t("settingsMcpName")}
                        </span>
                        <input
                          className="import-input w-full"
                          value={editing.name}
                          onChange={(e) =>
                            setEditing({ ...editing, name: e.target.value })
                          }
                          placeholder={t("settingsMcpNamePlaceholder")}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium text-foreground">
                          {t("settingsMcpCommand")}
                        </span>
                        <input
                          className="import-input w-full font-mono"
                          value={editing.command}
                          onChange={(e) =>
                            setEditing({ ...editing, command: e.target.value })
                          }
                          placeholder={t("settingsMcpCommandPlaceholder")}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium text-foreground">
                          {t("settingsMcpWorkingDirectory")}
                        </span>
                        <input
                          className="import-input w-full font-mono"
                          value={editing.cwd}
                          onChange={(e) =>
                            setEditing({ ...editing, cwd: e.target.value })
                          }
                          placeholder={t(
                            "settingsMcpWorkingDirectoryPlaceholder",
                          )}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium text-foreground">
                          {t("settingsMcpArgs")}
                        </span>
                        <textarea
                          className="import-input w-full font-mono"
                          rows={3}
                          value={editing.argsText}
                          onChange={(e) =>
                            setEditing({ ...editing, argsText: e.target.value })
                          }
                          placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir"}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium text-foreground">
                          {t("settingsMcpEnv")}
                        </span>
                        <textarea
                          className="import-input w-full font-mono"
                          rows={3}
                          value={editing.envText}
                          onChange={(e) =>
                            setEditing({ ...editing, envText: e.target.value })
                          }
                          placeholder="API_KEY=sk-xxx"
                        />
                      </label>
                      <div className="flex items-center gap-2">
                        <Switch
                          size="md"
                          aria-label={t("settingsMcpEnable")}
                          isSelected={editing.enabled}
                          onChange={(checked) =>
                            setEditing({
                              ...editing,
                              enabled: Boolean(checked),
                            })
                          }
                        >
                          <Switch.Content><Switch.Control>
                            <Switch.Thumb />
                          </Switch.Control></Switch.Content>
                        </Switch>
                        <span className="text-xs text-foreground">
                          {t("settingsMcpEnable")}
                        </span>
                      </div>
                      {saveError && (
                        <p role="alert" className="text-xs text-destructive">
                          {saveError}
                        </p>
                      )}
                      {testMessages[editing.id] && (
                        <p
                          role="status"
                          className="text-xs text-muted-foreground"
                        >
                          {testMessages[editing.id]}
                        </p>
                      )}
                    </fieldset>
                  </Modal.Body>
                  <Modal.Footer>
                    <fieldset
                      disabled={saving}
                      className="flex flex-wrap items-center justify-end gap-2"
                    >
                      <Button
                        size="sm"
                        variant="ghost"
                        isDisabled={saving}
                        onPress={() => setEditing(null)}
                      >
                        {t("settingsMcpClose")}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={
                          !editing.command.trim() || testingId !== null
                        }
                        onPress={() => void handleTest(draftToConfig(editing))}
                      >
                        {testingId === editing.id ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Wifi size={12} />
                        )}
                        {t("settingsMcpTest")}
                      </Button>
                      <Button
                        size="sm"
                        isPending={saving}
                        onPress={() => void handleSaveDraft()}
                      >
                        {t(servers.some((s) => s.id === editing.id) ? "settingsMcpSave" : "settingsMcpAddServer")}
                      </Button>
                    </fieldset>
                  </Modal.Footer>
                </>
              )}
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </SettingsCard>
  );
}
