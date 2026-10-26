import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, FolderOpen, Plus, X } from "lucide-react";
import { AppSelect } from "../../shared/ui/AppSelect";
import {
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContainer,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "@/shared/ui/ui/Dialog";
import { Input, Label, Field } from "@/shared/ui/ui/Field";
import { Button } from "@/shared/ui/ui/Button";
import { WorkspaceProjectRow } from "../workspace/WorkspaceProjectRow";
import { useWorkspaceCopy, workspacePathKey } from "../workspace/workspaceCopy";
import {
  projectApi,
  type WorkspaceLocation,
} from "../../adapters/transport/project";
import {
  listWslDistributions,
  type WslDistribution,
} from "../../adapters/transport/wsl";
import { resolveSessionsEntryPath } from "../agent-workspace/sessionLastVisit";
import { DirectoryPickerDialog } from "../../shared/ui/directory-picker/DirectoryPickerDialog";
import { useShellStore } from "../../shared/state/shellStore";
import {
  isElectron,
  openDirectoryPicker,
} from "../../adapters/electron/open-directory-picker";
import "./projectCreateDialog.css";

type Member = { location: WorkspaceLocation; name: string };
type Selection = { path: string; name: string };
const memberKey = ({ location }: Member) =>
  location.kind === "wsl"
    ? `wsl:${location.distribution.toLowerCase()}:${location.path.replace(/\/+$/, "") || "/"}`
    : `host:${workspacePathKey(location.path)}`;
const memberPath = ({ location }: Member) =>
  location.kind === "wsl"
    ? `${location.distribution} · ${location.path}`
    : location.path;
interface ProjectCreateDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ProjectCreateDialog({
  open,
  onClose,
}: ProjectCreateDialogProps) {
  return open ? <ProjectCreateForm onClose={onClose} /> : null;
}

function ProjectCreateForm({
  onClose,
}: Pick<ProjectCreateDialogProps, "onClose">) {
  const navigate = useNavigate();
  const c = useWorkspaceCopy();
  const [name, setName] = useState("");
  const nameEdited = useRef(false);
  const [members, setMembers] = useState<Member[]>([]);
  const membersRef = useRef<Member[]>([]);
  const [primaryKey, setPrimaryKey] = useState<string | null>(null);
  const [locationKind, setLocationKind] = useState<"host" | "wsl">("host");
  const [distributions, setDistributions] = useState<WslDistribution[]>([]);
  const [distribution, setDistribution] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const active = useRef(true);
  const locked = useRef(false);
  const pickerLocked = useRef(false);
  const browseRef = useRef<HTMLButtonElement>(null);
  const pickerWasOpen = useRef(false);

  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useLayoutEffect(() => {
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
        /* Local folders remain available when WSL is unavailable. */
      });
    return () => {
      current = false;
    };
  }, []);

  const close = () => {
    if (locked.current) return;
    active.current = false;
    onClose();
  };
  const addSelections = async (selections: Selection[]) => {
    if (!active.current || locked.current) return;
    setNotice("");
    let resolved;
    try {
      resolved = await Promise.all(selections.map(selection => projectApi.resolveWorkspacePath(
        locationKind === "wsl" ? { kind: "wsl", distribution, path: selection.path } : { kind: "host", path: selection.path },
      )));
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : c.unknownError);
      return;
    }
    if (!active.current) return;
    const redirected = resolved.filter(item => item.redirected);
    if (redirected.length) setNotice(redirected.map(item => `${c.worktreeRedirected}${item.location.path}`).join("\n"));
    const current = membersRef.current;
    const keys = new Set(current.map(memberKey));
    const additions: Member[] = [];
    let duplicate = false;
    for (const selection of resolved) {
      const member: Member = {
        name: selection.name,
        location: selection.location,
      };
      const key = memberKey(member);
      if (keys.has(key)) {
        duplicate = true;
        continue;
      }
      keys.add(key);
      additions.push(member);
    }
    if (current.length + additions.length > 50) {
      setError(c.limit);
      return;
    }
    if (additions.length) {
      const next = [...current, ...additions];
      membersRef.current = next;
      setMembers(next);
      if (!current.length) {
        setPrimaryKey(memberKey(additions[0]));
        if (!nameEdited.current) setName(additions[0].name);
      }
    }
    setError(duplicate ? c.duplicate : null);
  };
  const finishPicker = () => {
    pickerLocked.current = false;
    setPicking(false);
    setPickerOpen(false);
  };
  const browse = async () => {
    if (!active.current || locked.current || pickerLocked.current) return;
    pickerLocked.current = true;
    setPicking(true);
    setError(null);
    if (locationKind !== "host" || !isElectron) {
      setPickerOpen(true);
      return;
    }
    try {
      const selections = await openDirectoryPicker({ multiple: true });
      if (active.current && selections.length) await addSelections(selections);
    } catch (cause) {
      if (active.current)
        setError(
          `${c.browseError}: ${cause instanceof Error ? cause.message : c.unknownError}`,
        );
    } finally {
      if (active.current) finishPicker();
    }
  };
  const remove = (key: string) => {
    if (!active.current || locked.current || pickerLocked.current) return;
    const index = membersRef.current.findIndex(
      (member) => memberKey(member) === key,
    );
    const next = membersRef.current.filter(
      (member) => memberKey(member) !== key,
    );
    membersRef.current = next;
    setMembers(next);
    if (primaryKey === key)
      setPrimaryKey(next.length ? memberKey(next[index] ?? next[0]) : null);
    setError(null);
  };
  const createWorkspace = async () => {
    if (
      !active.current ||
      locked.current ||
      pickerLocked.current ||
      !members.length ||
      !name.trim()
    )
      return;
    locked.current = true;
    setSubmitting(true);
    setError(null);
    const primary =
      members.find((member) => memberKey(member) === primaryKey) ?? members[0];
    const ordered = [
      primary,
      ...members.filter((member) => member !== primary),
    ];
    try {
      const { project } = await projectApi.createWorkspace({
        name: name.trim(),
        roots: ordered.map((member) =>
          member.location.kind === "host"
            ? { localPath: member.location.path, name: member.name }
            : { location: member.location, name: member.name },
        ),
      });
      if (!active.current) return;
      active.current = false;
      useShellStore.getState().addProject(project);
      onClose();
      navigate(resolveSessionsEntryPath(project.id));
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : c.unknownError);
    } finally {
      if (active.current) {
        locked.current = false;
        setSubmitting(false);
      }
    }
  };
  const busy = submitting || picking;
  return (
    <>
      <Dialog open onClose={close} dismissible={!submitting && !pickerOpen}>
        <DialogContainer className="project-create-container">
          <DialogPanel className="project-create-panel">
            <DialogHeader className="project-create-header">
              <DialogTitle>{c.title}</DialogTitle>
              <DialogCloseButton
                aria-label={c.close}
                onClick={close}
                disabled={submitting}
              />
            </DialogHeader>
            <DialogDescription className="sr-only">
              {c.folderHint}
            </DialogDescription>
            <form
              className="project-create-form"
              onSubmit={(event) => {
                event.preventDefault();
                void createWorkspace();
              }}
            >
              <DialogBody className="project-create-body">
                <Field disabled={submitting}>
                  <Label>{c.workspaceName}</Label>
                  <Input
                    autoFocus
                    value={name}
                    placeholder={c.namePlaceholder}
                    onChange={(event) => {
                      nameEdited.current = true;
                      setName(event.target.value);
                    }}
                  />
                </Field>
                <section
                  className="project-create-projects"
                  aria-label={c.members}
                >
                  <h3 className="project-create-heading">{c.projects}</h3>
                  {distributions.length > 0 && (
                    <div className="project-create-environment">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-pressed={locationKind === "host"}
                        disabled={busy || members.length > 0}
                        onClick={() => setLocationKind("host")}
                      >
                        {c.localHost}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-pressed={locationKind === "wsl"}
                        disabled={busy || members.length > 0}
                        onClick={() => setLocationKind("wsl")}
                      >
                        WSL2
                      </Button>
                      {locationKind === "wsl" && (
                        <AppSelect
                          aria-label={c.wslDistribution}
                          value={distribution}
                          isDisabled={busy || members.length > 0}
                          onChange={(value) => {
                            if (value) setDistribution(value);
                          }}
                          options={distributions.map((item) => ({
                            key: item.name,
                            label: item.name,
                          }))}
                        />
                      )}
                    </div>
                  )}
                  {members.length ? (
                    <div
                      role="list"
                      aria-label={c.members}
                      className="project-create-list"
                    >
                      {members.map((member) => {
                        const key = memberKey(member);
                        const primary = key === primaryKey;
                        return (
                          <WorkspaceProjectRow
                            key={key}
                            projectId={key}
                            name={member.name}
                            path={memberPath(member)}
                            primary={primary}
                          >
                            {members.length > 1 && !primary && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                aria-label={`${c.makePrimary}: ${member.name}`}
                                title={c.makePrimary}
                                disabled={busy}
                                onClick={() => setPrimaryKey(key)}
                              >
                                {c.makePrimary}
                              </Button>
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              iconOnly
                              aria-label={`${c.remove}: ${member.name}`}
                              title={c.remove}
                              disabled={busy}
                              onClick={() => remove(key)}
                            >
                              <X size={14} />
                            </Button>
                          </WorkspaceProjectRow>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="project-create-empty">
                      <FolderOpen size={22} aria-hidden="true" />
                      <p>{c.folderHint}</p>
                    </div>
                  )}
                  <Button
                    ref={browseRef}
                    type="button"
                    variant="secondary"
                    className="project-create-browse"
                    disabled={
                      busy ||
                      members.length >= 50 ||
                      (locationKind === "wsl" && !distribution)
                    }
                    onClick={() => void browse()}
                  >
                    <Plus size={14} />
                    {members.length ? c.addProject : c.chooseFolder}
                  </Button>
                  {members.length > 0 && (
                    <p className="project-create-hint">{c.primaryHint}</p>
                  )}
                </section>
                {notice && <p className="project-create-hint" role="status">{notice}</p>}
                {error && (
                  <p className="project-create-error" role="alert">
                    <AlertCircle size={16} aria-hidden="true" />
                    <span>{error}</span>
                  </p>
                )}
              </DialogBody>
              <DialogFooter className="project-create-footer">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={submitting}
                  onClick={close}
                >
                  {c.cancel}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy || !members.length || !name.trim()}
                  pending={submitting}
                >
                  {submitting ? c.creating : c.createWorkspace}
                </Button>
              </DialogFooter>
            </form>
          </DialogPanel>
        </DialogContainer>
        {pickerOpen && (
          <DirectoryPickerDialog
            open
            multiple
            locationKind={locationKind}
            distribution={locationKind === "wsl" ? distribution : undefined}
            onClose={finishPicker}
            onSelect={(selection) => {
              void addSelections([selection]).finally(finishPicker);
            }}
            onSelectMultiple={(selections) => {
              void addSelections(selections).finally(finishPicker);
            }}
            labels={{ title: c.pickerTitle, confirmMultiple: c.pickerConfirm }}
          />
        )}
      </Dialog>
    </>
  );
}
