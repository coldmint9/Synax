import { Dialog, DialogContainer, DialogPanel, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/react/components/ui/Dialog";
import { Button } from "@/react/components/ui/Button";
import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import { agentRuntimeApi } from "../../../lib/api/agentRuntime";
import { handleError } from "../../../lib/errors";
import { useLocale } from "../../../hooks/useLocale";
import { useNotificationStore } from "../../state/notificationStore";
import { fileMutationBlockReason, type FileMutationRequest } from "./fileContextMutations";
import { useSessionWorkspaceStore } from "./state/sessionWorkspaceStore";
import { refreshWorkspace } from "./workspaceRefresh";

export function WorkspaceFileMutationHost() {
  const { t } = useLocale();
  const location = useLocation();
  const [request, setRequest] = useState<FileMutationRequest | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const listener = (event: Event) => {
      const next = (event as CustomEvent<FileMutationRequest>).detail;
      if (!next?.sessionId || !next.path) return;
      const reason = fileMutationBlockReason(next.sessionId, next.rootId, next.path);
      if (reason) {
        useNotificationStore.getState().push({ type: "warning", message: t(reason === "running" ? "contextFileRunning" : "contextFileUnsaved") });
        return;
      }
      setRequest(next);
      setName(next.path.split(/[\\/]/).pop() ?? next.path);
      setError(null);
    };
    document.addEventListener("workspace:file-mutation", listener);
    return () => document.removeEventListener("workspace:file-mutation", listener);
  }, [t]);
  useEffect(() => { setRequest(null); }, [location.key]);
  const close = () => { if (!busy) setRequest(null); };
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!request || busy) return;
    const reason = fileMutationBlockReason(request.sessionId, request.rootId, request.path);
    if (reason) { setError(t(reason === "running" ? "contextFileRunning" : "contextFileUnsaved")); return; }
    setBusy(true);
    setError(null);
    try {
      const store = useSessionWorkspaceStore.getState();
      if (request.kind === "rename") {
        const result = await agentRuntimeApi.renameSessionEnvironmentFile(request.sessionId, {
          path: request.path, newName: name, rootId: request.rootId,
        });
        if (result.path !== result.previousPath) store.renameFileTabs(request.sessionId, request.rootId, result.previousPath, result.path);
      } else {
        await agentRuntimeApi.trashSessionEnvironmentFile(request.sessionId, { path: request.path, rootId: request.rootId });
        store.closeFileTabs(request.sessionId, request.rootId, request.path);
      }
      refreshWorkspace(request.sessionId, request.rootId);
      useNotificationStore.getState().push({ type: "success", message: t(request.kind === "rename" ? "contextFileRenamed" : "contextFileTrashed") });
      setRequest(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      handleError(failure);
    } finally { setBusy(false); }
  };

  return <Dialog open={request !== null} onClose={close}>
    <DialogContainer size="sm">
      <DialogPanel aria-label={t(request?.kind === "trash" ? "contextTrashFile" : "contextRenameFile")}>
        <DialogHeader><DialogTitle>{t(request?.kind === "trash" ? "contextTrashFile" : "contextRenameFile")}</DialogTitle></DialogHeader>
        <DialogBody>
          {request?.kind === "rename" ? <form id="workspace-file-rename" onSubmit={(event) => void submit(event)}>
            <label htmlFor="workspace-file-name">{t("contextNewName")}</label>
            <input id="workspace-file-name" value={name} onChange={(event) => setName(event.target.value)} className="w-full rounded-lg border border-border bg-background p-2 text-sm" autoFocus disabled={busy} />
          </form> : <p>{t("contextTrashConfirm", { file: request?.path ?? "" })}</p>}
          {error && <p role="alert" className="text-danger text-xs">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy}>{t("commonCancel")}</Button>
          <Button variant={request?.kind === "trash" ? "danger" : "primary"} onClick={() => void submit()} disabled={busy || (request?.kind === "rename" && !name.trim())}>
            {t(request?.kind === "trash" ? "contextTrashFile" : "contextRenameFile")}
          </Button>
        </DialogFooter>
      </DialogPanel>
    </DialogContainer>
  </Dialog>;
}
