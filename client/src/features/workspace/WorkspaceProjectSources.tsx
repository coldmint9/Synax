import { useId, useState, type ReactNode, type Ref } from "react";
import {
  Tab,
  TabGroup,
  TabList,
  TabPanels,
  TabPanel,
} from "@/shared/ui/ui/Tabs";
import { Input, Label, Field } from "@/shared/ui/ui/Field";
import { Button } from "@/shared/ui/ui/Button";
import {
  ArrowRight,
  Check,
  FolderOpen,
  Layers2,
  Plus,
  Search,
  Terminal,
} from "lucide-react";
import type { ProjectSummary } from "../../shared/state/shellStore";
import { useWorkspaceCopy, workspacePathKey } from "./workspaceCopy";
import "./workspaceProjects.css";
import "./workspaceProjectSources.css";

const sourcePath = (project: ProjectSummary) =>
  project.source?.kind === "wsl"
    ? `${project.source.distribution ?? "WSL"} · ${project.source.wslPath ?? ""}`
    : (project.source?.localPath ?? "");

export function WorkspaceProjectSources({
  projects,
  loading,
  error,
  onRetry,
  disabled,
  paths,
  path = "",
  onPathChange = () => {},
  onBrowse,
  browseRef,
  onAddPath,
  onChoose,
  selectedId,
  mode,
  onModeChange,
  localLabel,
  directoryKind = "host",
  onDirectoryKindChange,
  wslSelector,
  locationSelector,
  simplified = false,
  compact = false,
  onCompactChange,
  allowManualPath = true,
}: {
  localLabel?: string;
  directoryKind?: "host" | "wsl";
  onDirectoryKindChange?: (kind: "host" | "wsl") => void;
  wslSelector?: ReactNode;
  locationSelector?: ReactNode;
  simplified?: boolean;
  /** Keep the first-run path focused on folder picking; reveal manual paths on demand. */
  compact?: boolean;
  onCompactChange?: (compact: boolean) => void;
  allowManualPath?: boolean;
  projects: ProjectSummary[];
  loading: boolean;
  error?: string | null;
  onRetry: () => void;
  disabled?: boolean;
  paths: string[];
  path?: string;
  onPathChange?: (path: string) => void;
  onBrowse: () => void;
  browseRef?: Ref<HTMLButtonElement>;
  onAddPath?: () => void;
  onChoose: (project: ProjectSummary) => void;
  selectedId?: string;
  mode: "local" | "existing";
  onModeChange: (mode: "local" | "existing") => void;
}) {
  const c = useWorkspaceCopy();
  const [search, setSearch] = useState("");
  const pathFieldId = useId();
  const query = search.trim().toLowerCase();
  const filtered = projects.filter((project) =>
    `${project.name} ${sourcePath(project)}`.toLowerCase().includes(query),
  );
  const included = new Set(paths.map(workspacePathKey));
  const duplicate =
    Boolean(path.trim()) && included.has(workspacePathKey(path));

  const localPanel = (
    <>
      {directoryKind === "wsl" && wslSelector ? (
        <div className="workspace-runtime-picker">{wslSelector}</div>
      ) : null}
      <Button
        ref={browseRef}
        variant="outline"
        className="workspace-directory-trigger"
        disabled={disabled}
        onClick={onBrowse}
      >
        <FolderOpen size={20} strokeWidth={1.7} aria-hidden="true" />
        <span>{c.chooseFolder}</span>
        <ArrowRight size={16} aria-hidden="true" />
      </Button>
      {simplified && (
        <div className="workspace-directory-alternatives">
          {allowManualPath && onCompactChange && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                aria-expanded={!compact}
                aria-controls={pathFieldId}
                onClick={() => onCompactChange(!compact)}
              >
                {c.manualPath}
              </Button>
              <span aria-hidden="true">·</span>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onModeChange("existing")}
          >
            {c.existing}
          </Button>
          {locationSelector && <span aria-hidden="true">·</span>}
          {locationSelector}
        </div>
      )}
      {allowManualPath && !compact && (
        <>
          <Field
            id={pathFieldId}
            disabled={disabled}
            className="workspace-path-field"
          >
            <Label>{c.path}</Label>
            <div className="workspace-path-control">
              <Input
                placeholder="/path/to/project"
                spellCheck={false}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    onAddPath &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    if (!duplicate) onAddPath();
                  }
                }}
                value={path}
                onChange={(event) => onPathChange(event.currentTarget.value)}
              />
              {onAddPath && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={disabled || !path.trim() || duplicate}
                  onClick={onAddPath}
                >
                  {c.add}
                </Button>
              )}
            </div>
          </Field>
          {duplicate && <p className="workspace-hint">{c.duplicate}</p>}
        </>
      )}
    </>
  );

  const existingPanel = (
    <>
      <Field disabled={disabled}>
        <div className="workspace-search">
          <Search size={14} />
          <Input
            aria-label={c.search}
            placeholder={c.search}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </div>
      </Field>
      <p className="workspace-hint">{c.existingHint}</p>
      {error ? (
        <div className="workspace-feedback" role="alert">
          <span>{error}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={onRetry}
          >
            {c.retry}
          </Button>
        </div>
      ) : loading ? (
        <p className="workspace-hint" role="status">
          {c.loading}
        </p>
      ) : (
        <div className="workspace-existing-list" aria-label={c.existing}>
          {filtered.length === 0 && (
            <div className="workspace-search-empty">
              <Layers2 size={22} strokeWidth={1.4} />
              <p>{query ? c.noMatches : c.noProjects}</p>
            </div>
          )}
          {filtered.map((project) => {
            const added = included.has(workspacePathKey(sourcePath(project)));
            return (
              <Button
                key={project.id}
                variant="ghost"
                className="workspace-existing-row"
                disabled={disabled || added}
                aria-pressed={selectedId === project.id}
                onClick={() => onChoose(project)}
              >
                <FolderOpen
                  size={16}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="workspace-project-text">
                  <strong>{project.name}</strong>
                  <span title={sourcePath(project)}>{sourcePath(project)}</span>
                </span>
                {added ? (
                  <span className="workspace-added">
                    <Check size={12} />
                    {c.included}
                  </span>
                ) : selectedId === project.id ? (
                  <Check size={15} />
                ) : (
                  <Plus size={14} className="shrink-0 text-muted-foreground" />
                )}
              </Button>
            );
          })}
        </div>
      )}
    </>
  );

  if (simplified) {
    return (
      <div className="workspace-sources workspace-sources--simple">
        {mode === "existing" ? (
          <>
            <div className="workspace-simple-mode-head">
              <div>
                <strong>{c.existing}</strong>
                <span>{c.existingHint}</span>
              </div>
              <div className="workspace-simple-mode-actions">
                {locationSelector}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => onModeChange("local")}
                >
                  <FolderOpen size={14} />
                  {c.local}
                </Button>
              </div>
            </div>
            {existingPanel}
          </>
        ) : (
          localPanel
        )}
      </div>
    );
  }

  const sourceModes = ["local", ...(wslSelector ? ["wsl"] : []), "existing"];
  const selectedMode =
    mode === "local" && directoryKind === "wsl" ? "wsl" : mode;

  return (
    <TabGroup
      selectedIndex={Math.max(0, sourceModes.indexOf(selectedMode))}
      onChange={(index) => {
        const key = sourceModes[index];
        onModeChange(key === "existing" ? "existing" : "local");
        if (key !== "existing")
          onDirectoryKindChange?.(key === "wsl" ? "wsl" : "host");
      }}
      className="workspace-sources"
    >
      <div className="workspace-source-tabs">
        <TabList aria-label={c.sources}>
          <Tab disabled={disabled}>
            <FolderOpen size={14} />
            {localLabel ?? c.local}
          </Tab>
          {wslSelector && (
            <Tab disabled={disabled}>
              <Terminal size={14} />
              WSL2
            </Tab>
          )}
          <Tab disabled={disabled}>
            <Layers2 size={14} />
            {c.existing}
          </Tab>
        </TabList>
      </div>
      <TabPanels>
        {["local", ...(wslSelector ? ["wsl"] : [])].map((id) => (
          <TabPanel key={id} className="workspace-source-panel">
            {id === "wsl" && wslSelector}
            {localPanel}
          </TabPanel>
        ))}
        <TabPanel className="workspace-source-panel">{existingPanel}</TabPanel>
      </TabPanels>
    </TabGroup>
  );
}
