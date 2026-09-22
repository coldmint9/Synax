import { DialogOverlay } from "../../components/DialogOverlay";
import { AppSelect } from "../../components/AppSelect";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Input, Label, TextField, Tooltip } from "@heroui/react";
import { ArrowRight, FolderCode, Layers2, Pin, X } from "lucide-react";
import { WorkspaceProjectSources } from "../workspace/WorkspaceProjectSources";
import { WorkspaceProjectRow } from "../workspace/WorkspaceProjectRow";
import { useWorkspaceCopy, workspacePathKey } from "../workspace/workspaceCopy";
import { projectApi, type WorkspaceLocation } from "../../../lib/api/project";
import {
  listWslDistributions,
  type WslDistribution,
} from "../../../lib/api/wsl";
import { resolveSessionsEntryPath } from "../agent-workspace/sessionLastVisit";
import { DirectoryPickerDialog } from "../../components/directory-picker/DirectoryPickerDialog";
import { useDialogFocus } from "../../components/directory-picker/useDialogFocus";
import { useShellStore, type ProjectSummary } from "../../state/shellStore";

type Member = { location: WorkspaceLocation; name: string; projectId?: string };
const memberKey = (member: Pick<Member, "location">) =>
  member.location.kind === "wsl"
    ? `wsl:${member.location.distribution.toLowerCase()}:${member.location.path}`
    : `host:${workspacePathKey(member.location.path)}`;
const memberPath = (member: Pick<Member, "location">) =>
  member.location.kind === "wsl"
    ? `${member.location.distribution} · ${member.location.path}`
    : member.location.path;
const projectLocation = (project: ProjectSummary): WorkspaceLocation | null =>
  project.source?.kind === "wsl" &&
  project.source.distribution &&
  project.source.wslPath
    ? {
        kind: "wsl",
        distribution: project.source.distribution,
        path: project.source.wslPath,
      }
    : project.source?.localPath
      ? { kind: "host", path: project.source.localPath }
      : null;
interface ProjectCreateDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ProjectCreateDialog({
  open,
  onClose,
}: ProjectCreateDialogProps) {
  // A new form instance isolates selections and in-flight callbacks on every opening.
  return open ? <ProjectCreateForm onClose={onClose} /> : null;
}

function ProjectCreateForm({
  onClose,
}: Pick<ProjectCreateDialogProps, "onClose">) {
  const navigate = useNavigate();
  const c = useWorkspaceCopy();
  const [mode, setMode] = useState<"local" | "existing">("local");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [name, setName] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [locationKind, setLocationKind] = useState<"host" | "wsl">("host");
  const [distributions, setDistributions] = useState<WslDistribution[]>([]);
  const [distribution, setDistribution] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [existing, setExisting] = useState<ProjectSummary[]>([]);
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [existingError, setExistingError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const locked = useRef(false);
  const active = useRef(true);
  const browseRef = useRef<HTMLButtonElement>(null);
  const pickerWasOpen = useRef(false);

  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    // Making the parent inert can blur its trigger before the child captures it.
    if (!pickerOpen && pickerWasOpen.current) browseRef.current?.focus();
    pickerWasOpen.current = pickerOpen;
  }, [pickerOpen]);

  useEffect(() => {
    const desktop = (window as Window & { electronAPI?: { platform: string } })
      .electronAPI;
    if (desktop?.platform !== "win32") return;
    let current = true;
    void listWslDistributions()
      .then((result) => {
        if (!current || !active.current || !result.available) return;
        const items = result.items.filter((item) => item.version === 2);
        setDistributions(items);
        setDistribution(
          items.find((item) => item.default)?.name ?? items[0]?.name ?? "",
        );
      })
      .catch(() => {
        // Keep WSL2 hidden when the local capability probe fails.
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    setLoadingExisting(true);
    setExistingError(null);
    void projectApi
      .listProjects(undefined, { throwOnError: true })
      .then((result) => {
        if (current && active.current)
          setExisting(
            result.items.filter((item) => Boolean(projectLocation(item))),
          );
      })
      .catch((cause) => {
        if (current && active.current)
          setExistingError(
            cause instanceof Error ? cause.message : String(cause),
          );
      })
      .finally(() => {
        if (current && active.current) setLoadingExisting(false);
      });
    return () => {
      current = false;
    };
  }, [loadAttempt]);

  const handleClose = () => {
    if (locked.current || !active.current) return;
    active.current = false;
    onClose();
  };
  const dialogRef = useDialogFocus(handleClose, pickerOpen);
  const addMembers = (items: Member[]) => {
    if (locked.current || !active.current) return;
    const additions = items.filter(
      (item, index) =>
        !members.some((member) => memberKey(member) === memberKey(item)) &&
        items.findIndex((other) => memberKey(other) === memberKey(item)) ===
          index,
    );
    if (members.length + additions.length > 50) {
      setError(c.limit);
      return;
    }
    const environments = [...members, ...additions].map((item) =>
      item.location.kind === "wsl"
        ? `wsl:${item.location.distribution.toLowerCase()}`
        : "host",
    );
    if (new Set(environments).size > 1) {
      setError(c.environmentMismatch);
      return;
    }
    setMembers((current) => [...current, ...additions]);
    setName((current) => current || items[0]?.name || "");
    setError(null);
  };
  const addPath = () => {
    const selectedPath = pathInput.trim();
    if (!selectedPath || (locationKind === "wsl" && !distribution)) return;
    const location: WorkspaceLocation =
      locationKind === "wsl"
        ? { kind: "wsl", distribution, path: selectedPath }
        : { kind: "host", path: selectedPath };
    addMembers([
      {
        location,
        name:
          selectedPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ||
          selectedPath,
      },
    ]);
    setPathInput("");
  };
  const createWorkspace = async () => {
    if (locked.current || !active.current || !members.length || !name.trim())
      return;
    locked.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const { project } = await projectApi.createWorkspace({
        name: name.trim(),
        roots: members.map((item) =>
          item.projectId
            ? { projectId: item.projectId }
            : item.location.kind === "host"
              ? { localPath: item.location.path, name: item.name }
              : { location: item.location, name: item.name },
        ),
      });
      if (!active.current) return;
      active.current = false;
      useShellStore.getState().addProject(project);
      onClose();
      navigate(resolveSessionsEntryPath(project.id));
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (active.current) {
        locked.current = false;
        setSubmitting(false);
      }
    }
  };
  return (
    <>
      <DialogOverlay
        inert={pickerOpen}
        aria-hidden={pickerOpen || undefined}
        onClick={handleClose}
      >
        <div
          ref={dialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="workspace-create-title"
          aria-describedby="workspace-create-intro"
          className="dialog-content workspace-create"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="workspace-create-header">
            <span className="workspace-project-icon workspace-project-icon--large">
              <Layers2 size={22} strokeWidth={1.5} />
            </span>
            <div>
              <h2 id="workspace-create-title">{c.title}</h2>
              <p id="workspace-create-intro">{c.intro}</p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              isIconOnly
              aria-label={c.close}
              isDisabled={submitting}
              onPress={handleClose}
            >
              <X size={17} />
            </Button>
          </header>
          <div className="workspace-create-name">
            <TextField value={name} onChange={setName} isDisabled={submitting}>
              <Label>{c.workspaceName}</Label>
              <Input
                maxLength={120}
                placeholder={c.namePlaceholder}
                data-dialog-autofocus
              />
            </TextField>
          </div>
          <div className="workspace-create-body">
            <section
              className="workspace-create-sources"
              aria-label={c.sources}
            >
              <WorkspaceProjectSources
                mode={mode}
                onModeChange={setMode}
                localLabel={c.localHost}
                directoryKind={locationKind}
                onDirectoryKindChange={(kind) => {
                  if (kind === locationKind) return;
                  setLocationKind(kind);
                  setPathInput("");
                  setMembers([]);
                  setError(null);
                }}
                wslSelector={
                  distributions.length > 0 ? (
                    <div className="workspace-runtime-picker">
                      <AppSelect
                        label={c.wslDistribution}
                        aria-label={c.wslDistribution}
                        value={distribution || null}
                        isDisabled={submitting}
                        onChange={(value) => {
                          if (!value) return;
                          setDistribution(value);
                          setPathInput("");
                          setMembers([]);
                          setError(null);
                        }}
                        options={distributions.map((item) => ({
                          key: item.name,
                          label: item.name,
                        }))}
                      />
                    </div>
                  ) : undefined
                }
                projects={existing}
                loading={loadingExisting}
                error={existingError}
                onRetry={() => setLoadAttempt((value) => value + 1)}
                disabled={submitting}
                paths={members.map(memberPath)}
                path={pathInput}
                onPathChange={setPathInput}
                onAddPath={addPath}
                browseRef={browseRef}
                onBrowse={() => setPickerOpen(true)}
                onChoose={(item) => {
                  const location = projectLocation(item);
                  if (location)
                    addMembers([
                      { projectId: item.id, name: item.name, location },
                    ]);
                }}
              />
            </section>
            <section className="workspace-create-members">
              <div className="workspace-section-label">
                <span>{c.members}</span>
                <span className="workspace-count">
                  {members.length.toString().padStart(2, "0")}
                </span>
              </div>
              <div
                className="workspace-member-list overflow-y-auto"
                role="list"
                aria-label={c.members}
              >
                {members.length === 0 && (
                  <div className="workspace-members-empty">
                    <span className="workspace-empty-glyph">
                      <FolderCode size={28} strokeWidth={1.2} />
                    </span>
                    <strong>{c.emptyTitle}</strong>
                    <p>{c.emptyHint}</p>
                  </div>
                )}
                {members.map((item, index) => (
                  <WorkspaceProjectRow
                    key={memberKey(item)}
                    name={item.name}
                    path={memberPath(item)}
                    primary={index === 0}
                  >
                    {index > 0 && (
                      <Tooltip delay={300}>
                        <Button
                          size="sm"
                          variant="ghost"
                          isIconOnly
                          aria-label={`${c.makePrimary}: ${item.name}`}
                          isDisabled={submitting}
                          onPress={() =>
                            setMembers((items) => [
                              item,
                              ...items.filter((member) => member !== item),
                            ])
                          }
                        >
                          <Pin size={13} />
                        </Button>
                        <Tooltip.Content>{c.makePrimary}</Tooltip.Content>
                      </Tooltip>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      isIconOnly
                      aria-label={`${c.remove} ${item.name}`}
                      isDisabled={submitting}
                      onPress={() =>
                        setMembers((items) =>
                          items.filter((member) => member !== item),
                        )
                      }
                    >
                      <X size={14} />
                    </Button>
                  </WorkspaceProjectRow>
                ))}
              </div>
              <p className="workspace-primary-note">
                <Pin size={12} />
                {c.primaryHint}
              </p>
            </section>
          </div>
          {error && (
            <div
              role="alert"
              className="workspace-feedback workspace-create-error"
            >
              {error}
            </div>
          )}
          <footer className="workspace-create-footer">
            <span role="status" className="workspace-hint">
              {c.count.replace("{count}", String(members.length))}
            </span>
            <div>
              <Button
                variant="ghost"
                size="sm"
                isDisabled={submitting}
                onPress={handleClose}
              >
                {c.cancel}
              </Button>
              <Button
                size="sm"
                isDisabled={submitting || !members.length || !name.trim()}
                isPending={submitting}
                onPress={() => void createWorkspace()}
              >
                {submitting ? c.creating : c.title}
                {!submitting && <ArrowRight size={14} />}
              </Button>
            </div>
          </footer>
        </div>
      </DialogOverlay>
      <DirectoryPickerDialog
        open={pickerOpen}
        multiple
        initialPath={pathInput.trim() || undefined}
        locationKind={locationKind}
        distribution={locationKind === "wsl" ? distribution : undefined}
        labels={{ title: c.pickerTitle, confirm: c.pickerConfirm }}
        onClose={() => setPickerOpen(false)}
        onSelect={() => {}}
        onSelectMultiple={(items) => {
          addMembers(
            items.map((item) => ({
              location:
                locationKind === "wsl"
                  ? { kind: "wsl" as const, distribution, path: item.path }
                  : { kind: "host" as const, path: item.path },
              name: item.name,
            })),
          );
          setPickerOpen(false);
        }}
      />
    </>
  );
}
