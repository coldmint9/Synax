import { AppSelect } from "../../shared/ui/AppSelect";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Tooltip } from "@/shared/ui/ui/Tooltip";
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
import {
  Tab,
  TabGroup,
  TabList,
  TabPanel,
  TabPanels,
} from "@/shared/ui/ui/Tabs";
import { Input, Label, Field } from "@/shared/ui/ui/Field";
import { Button } from "@/shared/ui/ui/Button";
import { ArrowRight, FolderOpen, Pin, Server, Terminal, X } from "lucide-react";
import { WorkspaceProjectSources } from "../workspace/WorkspaceProjectSources";
import { WorkspaceProjectRow } from "../workspace/WorkspaceProjectRow";
import { useWorkspaceCopy, workspacePathKey } from "../workspace/workspaceCopy";
import { projectApi, type WorkspaceLocation } from "../../adapters/transport/project";
import {
  listWslDistributions,
  type WslDistribution,
} from "../../adapters/transport/wsl";
import { resolveSessionsEntryPath } from "../agent-workspace/sessionLastVisit";
import { DirectoryPickerDialog } from "../../shared/ui/directory-picker/DirectoryPickerDialog";
import { useShellStore, type ProjectSummary } from "../../shared/state/shellStore";
import {
  isElectron,
  openDirectoryPicker,
} from "../../adapters/electron/open-directory-picker";

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
  const [sourceType, setSourceType] = useState<"local" | "remote">("local");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [name, setName] = useState("");
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

  const browseForDirectory = async () => {
    if (locationKind === "host" && isElectron) {
      try {
        const picked = await openDirectoryPicker();
        if (picked && active.current)
          addMembers([{ location: { kind: "host", path: picked.path }, name: picked.name }]);
      } catch (cause) {
        if (active.current)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
      return;
    }
    setPickerOpen(true);
  };

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
  const createWorkspace = async () => {
    if (
      locked.current ||
      !active.current ||
      sourceType !== "local" ||
      !members.length ||
      !name.trim()
    )
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
      <Dialog
        open
        onClose={handleClose}
        dismissible={!submitting}
        backdropClassName="bg-background"
        className="workspace-create-dialog"
      >
        <DialogContainer size="lg">
          <DialogPanel className="workspace-create">
          <DialogHeader className="workspace-create-header">
            <div>
              <DialogTitle>{c.title}</DialogTitle>
              <DialogDescription className="workspace-create-description">
                {c.intro}
              </DialogDescription>
            </div>
            <DialogCloseButton
              size="sm"
              variant="ghost"
              iconOnly
              aria-label={c.close}
              disabled={submitting}
            />
          </DialogHeader>
          <DialogBody className="workspace-create-dialog-body">
          <div className="workspace-create-name">
            <Field disabled={submitting}>
              <Label className="sr-only">{c.workspaceName}</Label>
              <div className="workspace-name-control">
                <FolderOpen size={18} aria-hidden="true" />
                <Input
                  maxLength={120}
                  placeholder={c.namePlaceholder}
                  aria-label={c.workspaceName}
                  data-dialog-autofocus
                  value={name}
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              </div>
            </Field>
          </div>
          <div className="workspace-create-body" data-source-type={sourceType}>
            <section
              className="workspace-create-sources"
              aria-label={c.sources}
            >
              <div className="workspace-create-section-label">{c.sources}</div>
              <TabGroup
                className="workspace-create-source-type"
                selectedIndex={sourceType === "local" ? 0 : 1}
                onChange={(index) => {
                  setSourceType(index === 0 ? "local" : "remote");
                  if (index === 0) {
                    setMode("local");
                  }
                  if (index === 0 && locationKind === "wsl") {
                    setLocationKind("host");
                    setMembers([]);
                  }
                  setError(null);
                }}
              >
                <TabList
                  className="workspace-create-source-type-tabs"
                  aria-label={c.sourceTypes}
                >
                  <Tab
                    disabled={submitting}
                    onClick={() => {
                      setMode("local");
                      if (locationKind === "wsl") {
                        setLocationKind("host");
                        setMembers([]);
                        setError(null);
                      }
                    }}
                  >
                    <FolderOpen size={15} aria-hidden="true" />
                    {c.local}
                  </Tab>
                  <Tab disabled={submitting}>
                    <Server size={15} aria-hidden="true" />
                    {c.remote}
                  </Tab>
                </TabList>
                <TabPanels>
                  <TabPanel className="workspace-create-source-panel">
                    <WorkspaceProjectSources
                      mode={mode}
                      onModeChange={setMode}
                      directoryKind={locationKind}
                      onDirectoryKindChange={(kind) => {
                        if (kind === locationKind) return;
                        setLocationKind(kind);
                        setMembers([]);
                        setError(null);
                      }}
                      wslSelector={
                        distributions.length > 0 ? (
                          <AppSelect
                            label={c.wslDistribution}
                            aria-label={c.wslDistribution}
                            value={distribution || null}
                            isDisabled={submitting}
                            onChange={(value) => {
                              if (!value) return;
                              setDistribution(value);
                              setMembers([]);
                              setError(null);
                            }}
                            options={distributions.map((item) => ({
                              key: item.name,
                              label: item.name,
                            }))}
                          />
                        ) : undefined
                      }
                      locationSelector={
                        distributions.length > 0 ? (
                          <div className="workspace-location-select">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={submitting}
                              onClick={() => {
                                setMode("local");
                                if (locationKind !== "wsl") {
                                  setLocationKind("wsl");
                                  setMembers([]);
                                }
                                setError(null);
                              }}
                            >
                              <Terminal size={14} />
                              WSL2
                            </Button>
                          </div>
                        ) : undefined
                      }
                      simplified
                      allowManualPath={false}
                      projects={existing}
                      loading={loadingExisting}
                      error={existingError}
                      onRetry={() => setLoadAttempt((value) => value + 1)}
                      disabled={submitting}
                      paths={members.map(memberPath)}
                      browseRef={browseRef}
                      onBrowse={() => void browseForDirectory()}
                      onChoose={(item) => {
                        const location = projectLocation(item);
                        if (location)
                          addMembers([
                            { projectId: item.id, name: item.name, location },
                          ]);
                      }}
                    />
                  </TabPanel>
                  <TabPanel className="workspace-create-source-panel">
                    <div
                      className="workspace-remote-placeholder"
                      aria-label={c.remoteTitle}
                    >
                      <div
                        className="workspace-remote-ascii"
                        aria-hidden="true"
                      >
                        <pre>{`┌──────┐
│  ▄▄  │
│ █  █ │
│  ▀▀  │
└──────┘`}</pre>
                      </div>
                      <strong>{c.remoteTitle}</strong>
                      <p>{c.remoteDescription}</p>
                      <span>{c.remoteComingSoon}</span>
                    </div>
                  </TabPanel>
                </TabPanels>
              </TabGroup>
            </section>
            <section
              className="workspace-create-members"
              data-empty={members.length === 0 || undefined}
            >
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
                      <Tooltip delay={300} content={<>{c.makePrimary}</>}>
                        <Button
                          size="sm"
                          variant="ghost"
                          iconOnly
                          aria-label={`${c.makePrimary}: ${item.name}`}
                          disabled={submitting}
                          onClick={() =>
                            setMembers((items) => [
                              item,
                              ...items.filter((member) => member !== item),
                            ])
                          }
                        >
                          <Pin size={13} />
                        </Button>
                      </Tooltip>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      aria-label={`${c.remove} ${item.name}`}
                      disabled={submitting}
                      onClick={() =>
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
          </DialogBody>
          <DialogFooter className="workspace-create-footer">
            <span role="status" className="workspace-hint">
              {c.count.replace("{count}", String(members.length))}
            </span>
            <div>
              <Button
                variant="ghost"
                size="sm"
                disabled={submitting}
                onClick={handleClose}
              >
                {c.cancel}
              </Button>
              <Button
                size="sm"
                disabled={
                  submitting ||
                  sourceType !== "local" ||
                  !members.length ||
                  !name.trim()
                }
                pending={submitting}
                className="workspace-create-submit"
                onClick={() => void createWorkspace()}
              >
                {submitting ? c.creating : c.title}
                {!submitting && <ArrowRight size={14} />}
              </Button>
            </div>
          </DialogFooter>
          </DialogPanel>
        </DialogContainer>
      </Dialog>
      <DirectoryPickerDialog
        open={pickerOpen}
        multiple
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
