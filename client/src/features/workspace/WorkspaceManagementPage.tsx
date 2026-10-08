import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, FolderOpen, Plus } from "lucide-react";
import { Button } from "@/shared/ui/ui/Button";
import { Field, Input, Label } from "@/shared/ui/ui/Field";
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
import { resolveSessionsEntryPath } from "../agent-workspace/sessionLastVisit";
import { WorkspaceProjectRow } from "./WorkspaceProjectRow";
import { useWorkspaceCopy, workspacePathKey } from "./workspaceCopy";
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
  const navigate = useNavigate();
  const route = useLocation();
  const project = useShellStore((s) =>
    s.projects.find((p) => p.id === workspaceId),
  );
  const [workspace, setWorkspace] = useState<ProjectWorkspace | null>(null);
  const [busy, setBusy] = useState<Busy | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [adding, setAdding] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const active = useRef(false);
  const lock = useRef(false);
  const addTrigger = useRef<HTMLButtonElement>(null);
  const cancelRemove = useRef<HTMLButtonElement>(null);
  const closeAdd = useRef<HTMLButtonElement>(null);
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
  const duplicate = Boolean(
    selection &&
    roots.some(
      (root) =>
        workspacePathKey(root.path) === workspacePathKey(selection.path),
    ),
  );

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
  }, [busy, adding, removeId, workspace]);
  useLayoutEffect(() => {
    if (removeId && !busy) cancelRemove.current?.focus();
  }, [removeId]);
  useLayoutEffect(() => {
    if (adding) closeAdd.current?.focus();
  }, [adding]);

  const browse = () => {
    if (busy || !location) return;
    if (!isElectron || location.kind === "wsl") {
      setPickerOpen(true);
      return;
    }
    void run("browse", c.browseError, async () => {
      const result = await openDirectoryPicker();
      if (active.current && result) setSelection(result);
    });
  };
  const add = () => {
    if (!selection || !location || duplicate || roots.length >= 50) return;
    const selected = selection;
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
      setSelection(null);
      setAdding(false);
      setNotice(c.added);
      focusAfter.current = "add";
    });
  };
  const remove = () => {
    if (
      !removeId ||
      roots.find((root) => root.id === removeId)?.role !== "reference"
    )
      return;
    const id = removeId;
    const next = filtered
      .slice(filtered.findIndex((root) => root.id === id) + 1)
      .find((root) => root.role === "reference");
    void run("remove", c.removeError, async () => {
      const result = await projectApi.removeReference(workspaceId, id);
      if (!active.current) return;
      setWorkspace(result);
      setRemoveId(null);
      setNotice(c.removed);
      focusAfter.current = next?.id ?? "add";
    });
  };
  const back = () => {
    const from = (route.state as { returnTo?: string } | null)?.returnTo;
    navigate(
      from?.startsWith("/") ? from : resolveSessionsEntryPath(workspaceId),
    );
  };
  const disabled = Boolean(busy);

  return (
    <main className="workspace-manager">
      <div className="workspace-manager-content">
        <Button variant="ghost" size="sm" disabled={disabled} onClick={back}>
          <ArrowLeft size={14} />
          {c.backWorkspace}
        </Button>
        <header className="workspace-manager-header">
          <p>{c.manageWorkspace}</p>
          <h1>{project?.name ?? primary?.name ?? workspaceId}</h1>
          <p>
            {c.projectCount.replace("{count}", String(roots.length))}
            {location &&
              ` · ${location.kind === "wsl" ? `WSL · ${location.distribution}` : c.localHost}`}
          </p>
        </header>
        <div className="workspace-manager-heading">
          <h2>{c.members}</h2>
          <Button
            ref={addTrigger}
            variant="ghost"
            size="sm"
            disabled={
              disabled ||
              !workspace ||
              adding ||
              Boolean(removeId) ||
              roots.length >= 50
            }
            onClick={() => {
              setAdding(true);
              setError(null);
              setNotice("");
            }}
          >
            <Plus size={14} />
            {c.addProject}
          </Button>
        </div>
        {roots.length >= 50 && (
          <p className="workspace-manager-note">{c.limit}</p>
        )}
        {(roots.length > 8 || search) && (
          <Field className="workspace-manager-search">
            <Label className="sr-only">{c.search}</Label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={c.search}
            />
          </Field>
        )}
        {busy === "load" && (
          <p role="status" className="workspace-manager-status">
            {c.loadingWorkspace}
          </p>
        )}
        {error && (
          <div role="alert" className="workspace-manager-error">
            {error}
            {!workspace && (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => void reload()}
              >
                {c.retry}
              </Button>
            )}
          </div>
        )}
        {notice && (
          <p role="status" className="workspace-manager-status">
            {notice}
          </p>
        )}
        {adding && (
          <section aria-label={c.addProject} className="workspace-manager-add">
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={browse}
            >
              <FolderOpen size={14} />
              {selection ? c.reselect : c.chooseFolder}
            </Button>
            {selection && (
              <>
                <p className="workspace-manager-note" title={selection.path}>
                  {selection.path}
                </p>
                <Field>
                  <Label>{c.projectName}</Label>
                  <Input
                    disabled={disabled}
                    value={selection.name}
                    onChange={(e) =>
                      setSelection({ ...selection, name: e.target.value })
                    }
                  />
                </Field>
              </>
            )}
            {duplicate && (
              <p role="alert" className="workspace-manager-error">
                {c.duplicate}
              </p>
            )}
            <div className="workspace-manager-actions">
              <Button
                ref={closeAdd}
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => {
                  setAdding(false);
                  setSelection(null);
                  setError(null);
                  focusAfter.current = "add";
                }}
              >
                {c.cancel}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={disabled || !selection || duplicate}
                pending={busy === "add"}
                onClick={add}
              >
                {c.confirmAdd}
              </Button>
            </div>
          </section>
        )}
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
                    disabled={disabled || adding}
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
              {removeId === root.id && (
                <section
                  className="workspace-manager-confirm"
                  aria-label={c.removePrompt.replace("{name}", root.name)}
                >
                  <p className="text-sm font-medium">
                    {c.removePrompt.replace("{name}", root.name)}
                  </p>
                  <p className="workspace-manager-note">{c.unlinkDetails}</p>
                  <div className="workspace-manager-actions">
                    <Button
                      ref={cancelRemove}
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      onClick={() => {
                        setRemoveId(null);
                        setError(null);
                        focusAfter.current = root.id;
                      }}
                    >
                      {c.cancel}
                    </Button>
                    <Button
                      variant="danger-soft"
                      size="sm"
                      disabled={disabled}
                      pending={busy === "remove"}
                      onClick={remove}
                    >
                      {c.confirmRemove}
                    </Button>
                  </div>
                </section>
              )}
            </div>
          ))}
        </div>
        {workspace && !filtered.length && (
          <p className="workspace-manager-note">
            {query ? c.noMatches : c.noRoots}
          </p>
        )}
        {roots.length === 1 && (
          <p className="workspace-manager-note">{c.noReferences}</p>
        )}
        <p className="workspace-manager-note mt-5">{c.unlinkHint}</p>
        <p className="workspace-manager-note">{c.nextRun}</p>
      </div>
      <DirectoryPickerDialog
        open={pickerOpen}
        locationKind={location?.kind ?? "host"}
        distribution={
          location?.kind === "wsl" ? location.distribution : undefined
        }
        labels={{ title: c.pickerTitle, confirm: c.chooseFolder }}
        onClose={() => setPickerOpen(false)}
        onSelect={(item) => {
          if (active.current) {
            setSelection(item);
            setPickerOpen(false);
          }
        }}
      />
    </main>
  );
}
