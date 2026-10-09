import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import { Button } from "@/shared/ui/ui/Button";
import {
  Dialog,
  DialogBody,
  DialogContainer,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "@/shared/ui/ui/Dialog";
import "./workspaceControls.css";

type Props = {
  workspace: { id: string; name: string } | null;
  currentProjectId: string | null;
  onRemove: (id: string) => Promise<void>;
  onClose: () => void;
};
export function WorkspaceRemoveDialog(props: Props) {
  return props.workspace ? (
    <RemoveForm
      key={props.workspace.id}
      {...props}
      workspace={props.workspace}
    />
  ) : null;
}
function RemoveForm({
  workspace,
  currentProjectId,
  onRemove,
  onClose,
}: Props & { workspace: NonNullable<Props["workspace"]> }) {
  const { t } = useLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const remove = async () => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      await onRemove(workspace.id);
      if (mounted.current) onClose();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      lock.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return (
    <Dialog open onClose={onClose} dismissible={!pending}>
      <DialogContainer size="sm">
        <DialogPanel className="workspace-dialog">
          <DialogHeader>
            <Trash2 size={18} className="text-destructive" aria-hidden="true" />
            <DialogTitle>{t("appRemoveProject")}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p>{t("appRemoveProjectConfirm", { name: workspace.name })}</p>
            {workspace.id === currentProjectId && (
              <p className="workspace-feedback">
                {t("appRemoveProjectRunning")}
              </p>
            )}
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
            <Button autoFocus disabled={pending} onClick={onClose}>
              {t("appCancel")}
            </Button>
            <Button
              variant="danger"
              pending={pending}
              onClick={() => void remove()}
            >
              {pending ? t("appRemoving") : t("appConfirmRemove")}
            </Button>
          </DialogFooter>
        </DialogPanel>
      </DialogContainer>
    </Dialog>
  );
}
