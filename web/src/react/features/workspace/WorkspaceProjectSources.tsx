import { useState, type ReactNode, type Ref } from "react";
import {
  Tab,
  TabGroup,
  TabList,
  TabPanels,
  TabPanel,
} from "@/react/components/ui/Tabs";
import { Input, Label, Field } from "@/react/components/ui/Field";
import { Button } from "@/react/components/ui/Button";
import {
  Check,
  FolderOpen,
  Layers2,
  Plus,
  Search,
  Terminal,
} from "lucide-react";
import type { ProjectSummary } from "../../state/shellStore";
import { useWorkspaceCopy, workspacePathKey } from "./workspaceCopy";
import "./workspaceProjects.css";

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
  path,
  onPathChange,
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
}: {
  localLabel?: string;
  directoryKind?: "host" | "wsl";
  onDirectoryKindChange?: (kind: "host" | "wsl") => void;
  wslSelector?: ReactNode;
  projects: ProjectSummary[];
  loading: boolean;
  error?: string | null;
  onRetry: () => void;
  disabled?: boolean;
  paths: string[];
  path: string;
  onPathChange: (path: string) => void;
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
  const query = search.trim().toLowerCase();
  const filtered = projects.filter((project) =>
    `${project.name} ${sourcePath(project)}`.toLowerCase().includes(query),
  );
  const included = new Set(paths.map(workspacePathKey));
  const duplicate =
    Boolean(path.trim()) && included.has(workspacePathKey(path));
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
            <Button
              ref={browseRef}
              variant="outline"
              className="workspace-browse"
              disabled={disabled}
              onClick={onBrowse}
              aria-label={c.browse}
            >
              <span className="workspace-project-icon workspace-project-icon--large">
                <FolderOpen size={23} strokeWidth={1.5} />
              </span>
              <span className="workspace-browse-title">{c.browseTitle}</span>
              <span className="workspace-hint">
                {onAddPath ? c.browseHint : c.singleBrowseHint}
              </span>
              <span className="workspace-browse-action">
                {c.browse}
                <Plus size={12} />
              </span>
            </Button>
            <Field disabled={disabled} className="workspace-path-field">
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
          </TabPanel>
        ))}
        <TabPanel className="workspace-source-panel">
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
                const added = included.has(
                  workspacePathKey(sourcePath(project)),
                );
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
                      <span title={sourcePath(project)}>
                        {sourcePath(project)}
                      </span>
                    </span>
                    {added ? (
                      <span className="workspace-added">
                        <Check size={12} />
                        {c.included}
                      </span>
                    ) : selectedId === project.id ? (
                      <Check size={15} />
                    ) : (
                      <Plus
                        size={14}
                        className="shrink-0 text-muted-foreground"
                      />
                    )}
                  </Button>
                );
              })}
            </div>
          )}
        </TabPanel>
      </TabPanels>
    </TabGroup>
  );
}
