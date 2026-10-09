import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  ArrowUpRight,
  Check,
  Ellipsis,
  Folder,
  GitBranch,
  Info,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/shared/ui/ui/Button";
import { Field, Input, Label } from "@/shared/ui/ui/Field";
import { Menu, MenuAction, MenuButton, MenuItems } from "@/shared/ui/ui/Menu";
import {
  Dialog,
  DialogBody,
  DialogContainer,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "@/shared/ui/ui/Dialog";
import {
  projectApi,
  type ProjectWorkspace,
  type WorkspaceLocation,
} from "../../adapters/transport/project";
import {
  isElectron,
  openDirectoryPicker,
} from "../../adapters/electron/open-directory-picker";
import { DirectoryPickerDialog } from "../../shared/ui/directory-picker/DirectoryPickerDialog";
import { useShellStore } from "../../shared/state/shellStore";
import { useLocale } from "../../shared/hooks/useLocale";
import { resolveSessionsEntryPath } from "../agent-workspace/sessionLastVisit";
import { WorkspaceProjectRow } from "./WorkspaceProjectRow";
import { WorkspaceRenameDialog } from "./WorkspaceRenameDialog";
import { WorkspaceRemoveDialog } from "./WorkspaceRemoveDialog";
import { useWorkspaceCopy } from "./workspaceCopy";
import "./workspaceManagement.css";

type Selection = { path: string; name: string };
type Busy = "load" | "browse" | "add" | "remove";
export default function WorkspaceManagementPage() {
  const { workspaceId = "" } = useParams();
  return (
    <WorkspaceManagementContent key={workspaceId} workspaceId={workspaceId} />
  );
}

export function WorkspaceManagementContent({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const c = useWorkspaceCopy();
  const { t } = useLocale();
  const navigate = useNavigate();
  const route = useLocation();
  const outlet = useOutletContext<
    { onRemoveProject?: (id: string) => Promise<void> } | undefined
  >();
  const project = useShellStore((s) =>
    s.projects.find((p) => p.id === workspaceId),
  );
  const currentProjectId = useShellStore((s) => s.currentProjectId);
  const [workspace, setWorkspace] = useState<ProjectWorkspace | null>(null);
  const [busy, setBusy] = useState<Busy | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [removeWorkspaceOpen, setRemoveWorkspaceOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const active = useRef(false);
  const lock = useRef(false);
  const addTrigger = useRef<HTMLButtonElement>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfter = useRef<string | "add" | null>(null);
  const primary = workspace?.roots.find((root) => root.role === "primary");
  const location: WorkspaceLocation | undefined =
    primary?.location ??
    (primary ? { kind: "host", path: primary.path } : undefined);
  const roots = workspace?.roots ?? [];
  const query = search.trim().toLowerCase();
  const filtered = roots.filter((root) =>
    `${root.name} ${root.path}`.toLowerCase().includes(query),
  );
  const removeTarget = roots.find((root) => root.id === removeId);
  const run = useCallback(
    async (action: Busy, failure: string, work: () => Promise<void>) => {
      if (lock.current || !active.current) return;
      lock.current = true;
      setBusy(action);
      setError(null);
      setNotice("");
      try {
        await work();
      } catch (cause) {
        if (active.current)
          setError(
            `${failure}: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
      } finally {
        if (active.current) {
          lock.current = false;
          setBusy(null);
        }
      }
    },
    [],
  );
  const reload = useCallback(
    () =>
      run("load", c.loadError, async () => {
        const result = await projectApi.getWorkspace(workspaceId);
        if (active.current) setWorkspace(result);
      }),
    [workspaceId, c.loadError, run],
  );
  useEffect(() => {
    active.current = true;
    void reload();
    return () => {
      active.current = false;
    };
  }, [reload]);
  useLayoutEffect(() => {
    if (busy || !focusAfter.current) return;
    const target = focusAfter.current;
    focusAfter.current = null;
    (target === "add"
      ? addTrigger.current
      : (removeButtons.current.get(target) ?? addTrigger.current)
    )?.focus();
  }, [busy, removeId, workspace, pickerOpen]);
  const addSelection = (selected: Selection) => {
    if (!location || roots.length >= 50) return;
    void run("add", c.addError, async () => {
      const result = await projectApi.addReference(workspaceId, {
        location:
          location.kind === "wsl"
            ? {
                kind: "wsl",
                distribution: location.distribution,
                path: selected.path,
              }
            : { kind: "host", path: selected.path },
        ...(selected.name.trim() ? { name: selected.name.trim() } : {}),
      });
      if (!active.current) return;
      setWorkspace(result);
      setNotice(c.added);
      focusAfter.current = "add";
    });
  };
  const browse = async () => {
    if (lock.current || busy || pickerOpen || !location) return;
    setError(null);
    setNotice("");
    if (!isElectron || location.kind === "wsl") {
      setPickerOpen(true);
      return;
    }
    let selected: Selection | null = null;
    await run("browse", c.browseError, async () => {
      selected = await openDirectoryPicker();
    });
    if (active.current && selected) addSelection(selected);
  };
  const cancelRemove = () => {
    if (busy) return;
    focusAfter.current = removeId;
    setRemoveId(null);
    setError(null);
  };
  const remove = () => {
    if (!removeTarget || removeTarget.role !== "reference") return;
    const next = filtered
      .slice(filtered.findIndex((root) => root.id === removeTarget.id) + 1)
      .find((root) => root.role === "reference");
    void run("remove", c.removeError, async () => {
      const result = await projectApi.removeReference(
        workspaceId,
        removeTarget.id,
      );
      if (!active.current) return;
      setWorkspace(result);
      setRemoveId(null);
      setNotice(c.removed);
      focusAfter.current = next?.id ?? "add";
    });
  };
  const back = () => {
    const state = route.state as {
      workspaceReturnTo?: string;
      returnTo?: string;
    } | null;
    const from = state?.workspaceReturnTo ?? state?.returnTo;
    navigate(
      from?.startsWith("/") && !from.startsWith("//")
        ? from
        : resolveSessionsEntryPath(workspaceId),
    );
  };
  const disabled = Boolean(busy);
  return (
    <main className="workspace-manager">
      <div className="workspace-manager-content">
        <Button
          variant="ghost"
          size="sm"
          onClick={back}
          className="workspace-manager-back"
        >
          <ArrowLeft size={14} />
          {c.backWorkspace}
        </Button>
        <header className="workspace-manager-header">
          <div className="workspace-manager-title">
            <p className="workspace-manager-eyebrow">{c.manageWorkspace}</p>
            <h1>{project?.name ?? primary?.name ?? workspaceId}</h1>
            <p className="workspace-manager-note">
              {workspace
                ? c.projectCount.replace("{count}", String(roots.length))
                : busy === "load"
                  ? c.loadingWorkspace
                  : c.loadError}
              {location &&
                ` · ${location.kind === "wsl" ? `WSL · ${location.distribution}` : c.localHost}`}
            </p>
          </div>
          <div className="workspace-manager-header-actions">
            <Button
              aria-label={c.renameWorkspace}
              disabled={!project}
              onClick={() => setRenameOpen(true)}
            >
              <Pencil size={14} />
              <span className="workspace-manager-rename-label">
                {c.renameWorkspace}
              </span>
            </Button>
            {outlet?.onRemoveProject && project && (
              <Menu>
                <MenuButton
                  className="workspace-manager-more"
                  aria-label={c.workspaceMore}
                >
                  <Ellipsis size={18} />
                </MenuButton>
                <MenuItems anchor={{ to: "bottom end", gap: 8, padding: 8 }}>
                  <MenuAction
                    danger
                    onClick={() => setRemoveWorkspaceOpen(true)}
                  >
                    <Trash2 size={14} />
                    {t("appRemoveProject")}
                  </MenuAction>
                </MenuItems>
              </Menu>
            )}
          </div>
        </header>
        {notice && (
          <p role="status" className="workspace-manager-notice">
            <Check size={15} aria-hidden="true" />
            {notice}
          </p>
        )}
        <section
          className="workspace-manager-card"
          aria-labelledby="workspace-members-title"
          aria-busy={busy === "load"}
        >
          <div className="workspace-manager-heading">
            <div>
              <h2 id="workspace-members-title">
                {c.members}
                <span className="workspace-manager-count">
                  {workspace ? roots.length : "—"}
                </span>
              </h2>
              <p className="workspace-manager-note">{c.manageHint}</p>
            </div>
            <Button
              ref={addTrigger}
              variant="primary"
              pending={busy === "add" || busy === "browse"}
              disabled={
                disabled ||
                !location ||
                Boolean(removeId) ||
                pickerOpen ||
                roots.length >= 50
              }
              onClick={() => void browse()}
            >
              <Plus size={14} />
              {busy === "add" ? c.adding : c.addProject}
            </Button>
          </div>
          {roots.length >= 50 && (
            <p className="workspace-manager-limit">{c.limit}</p>
          )}
          {(roots.length > 8 || search) && (
            <Field className="workspace-manager-search">
              <Label className="sr-only">{c.search}</Label>
              <Search size={15} aria-hidden="true" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={c.search}
              />
            </Field>
          )}
          {busy === "load" && (
            <div className="workspace-manager-loading" role="status">
              <span className="sr-only">{c.loadingWorkspace}</span>
              {[0, 1, 2].map((i) => (
                <div
                  className="workspace-manager-skeleton"
                  key={i}
                  aria-hidden="true"
                >
                  <span />
                  <div>
                    <span />
                    <span />
                  </div>
                </div>
              ))}
            </div>
          )}
          {error && !removeId && (
            <div role="alert" className="workspace-manager-error">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{error}</span>
              {!workspace && (
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() => void reload()}
                >
                  {c.retry}
                </Button>
              )}
            </div>
          )}
          {busy !== "load" && (
            <div role="list" aria-label={c.members}>
              {filtered.map((root) => (
                <div key={root.id} className="workspace-manager-member">
                  <WorkspaceProjectRow
                    name={root.name}
                    path={
                      root.location?.kind === "wsl"
                        ? `${root.location.distribution} · ${root.path}`
                        : root.path
                    }
                    primary={root.role === "primary"}
                    missing={root.status === "missing"}
                  >
                    {root.role === "reference" && (
                      <Button
                        ref={(el) => {
                          if (el) removeButtons.current.set(root.id, el);
                          else removeButtons.current.delete(root.id);
                        }}
                        variant="ghost"
                        size="sm"
                        disabled={disabled}
                        aria-label={`${c.remove}: ${root.name}`}
                        onClick={() => {
                          setRemoveId(root.id);
                          setError(null);
                          setNotice("");
                        }}
                      >
                        {c.remove}
                      </Button>
                    )}
                  </WorkspaceProjectRow>
                </div>
              ))}
            </div>
          )}
          {workspace && !filtered.length && busy !== "load" && (
            <div className="workspace-manager-empty">
              <Folder size={28} aria-hidden="true" />
              <h3>{query ? c.noMatches : c.noRoots}</h3>
              <p>{query ? c.search : c.emptyHint}</p>
              {query && (
                <Button variant="secondary" onClick={() => setSearch("")}>
                  {c.clearSearch}
                </Button>
              )}
            </div>
          )}
          <div className="workspace-manager-footer">
            <Info size={14} aria-hidden="true" />
            <span>
              {c.unlinkHint} {c.nextRun}
            </span>
          </div>
        </section>
        {primary?.status === "available" && (
          <section className="workspace-manager-git">
            <span className="workspace-manager-git-icon">
              <GitBranch size={20} aria-hidden="true" />
            </span>
            <div>
              <h2>{c.gitWorktrees}</h2>
              <p className="workspace-manager-note">{c.gitWorktreesHint}</p>
            </div>
            <Link
              className="workspace-manager-git-link"
              to={`/projects/${encodeURIComponent(workspaceId)}/git?view=worktrees`}
            >
              {c.openGit}
              <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          </section>
        )}
      </div>
      <Dialog
        open={Boolean(removeTarget)}
        onClose={cancelRemove}
        dismissible={!busy}
      >
        <DialogContainer size="sm">
          <DialogPanel className="workspace-dialog">
            <DialogHeader>
              <Trash2
                size={18}
                className="text-destructive"
                aria-hidden="true"
              />
              <DialogTitle>
                {c.removePrompt.replace("{name}", removeTarget?.name ?? "")}
              </DialogTitle>
            </DialogHeader>
            <DialogBody>
              <p>{c.unlinkDetails}</p>
              {error && (
                <p
                  role="alert"
                  className="workspace-feedback workspace-feedback--error"
                >
                  {error}
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button autoFocus disabled={disabled} onClick={cancelRemove}>
                {c.cancel}
              </Button>
              <Button
                variant="danger"
                pending={busy === "remove"}
                disabled={disabled}
                onClick={remove}
              >
                {busy === "remove" ? c.removing : c.confirmRemove}
              </Button>
            </DialogFooter>
          </DialogPanel>
        </DialogContainer>
      </Dialog>
      <WorkspaceRenameDialog
        workspace={renameOpen && project ? project : null}
        onClose={() => setRenameOpen(false)}
        onRenamed={() => setNotice(c.renamed)}
      />
      {outlet?.onRemoveProject && (
        <WorkspaceRemoveDialog
          workspace={removeWorkspaceOpen && project ? project : null}
          currentProjectId={currentProjectId}
          onRemove={outlet.onRemoveProject}
          onClose={() => setRemoveWorkspaceOpen(false)}
        />
      )}
      <DirectoryPickerDialog
        open={pickerOpen}
        locationKind={location?.kind ?? "host"}
        distribution={
          location?.kind === "wsl" ? location.distribution : undefined
        }
        labels={{ title: c.pickerTitle, confirm: c.chooseFolder }}
        onClose={() => {
          focusAfter.current = "add";
          setPickerOpen(false);
        }}
        onSelect={(selected) => {
          setPickerOpen(false);
          addSelection(selected);
        }}
      />
    </main>
  );
}
