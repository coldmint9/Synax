import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { projectApi } from "../../adapters/transport/project";
import { useShellStore } from "../../shared/state/shellStore";
import { Button } from "@/shared/ui/ui/Button";
import { Field, Input, Label } from "@/shared/ui/ui/Field";
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
import { useWorkspaceCopy } from "./workspaceCopy";
import "./workspaceControls.css";

type Target = { id: string; name: string };
type Props = {
  workspace: Target | null;
  onClose: () => void;
  onRenamed?: () => void;
};

export function WorkspaceRenameDialog({ workspace, ...props }: Props) {
  return workspace ? (
    <RenameForm key={workspace.id} workspace={workspace} {...props} />
  ) : null;
}

function RenameForm({
  workspace,
  onClose,
  onRenamed,
}: Omit<Props, "workspace"> & { workspace: Target }) {
  const c = useWorkspaceCopy();
  const [name, setName] = useState(workspace.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const save = async () => {
    const trimmed = name.trim();
    if (locked.current || !trimmed) return;
    locked.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await projectApi.updateProject(workspace.id, {
        name: trimmed,
      });
      useShellStore
        .getState()
        .updateProject(workspace.id, { name: result.name });
      if (mounted.current) {
        onRenamed?.();
        onClose();
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          `${c.renameError}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
    } finally {
      locked.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return (
    <Dialog open onClose={onClose} dismissible={!pending}>
      <DialogContainer size="sm">
        <DialogPanel className="workspace-dialog">
          <DialogHeader>
            <Pencil size={18} aria-hidden="true" />
            <DialogTitle>{c.renameWorkspace}</DialogTitle>
          </DialogHeader>
          <DialogCloseButton disabled={pending} aria-label={c.close} />
          <DialogDescription>{c.renameHint}</DialogDescription>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <DialogBody>
              <Field disabled={pending}>
                <Label>{c.workspaceName}</Label>
                <Input
                  autoFocus
                  value={name}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="off"
                />
              </Field>
              {error && (
                <p
                  className="workspace-feedback workspace-feedback--error"
                  role="alert"
                >
                  {error}
                </p>
              )}
            </DialogBody>
            <DialogFooter className="workspace-dialog-footer">
              <Button disabled={pending} onClick={onClose}>
                {c.cancel}
              </Button>
              <Button
                type="submit"
                variant="primary"
                pending={pending}
                disabled={!name.trim()}
              >
                {pending ? c.saving : c.save}
              </Button>
            </DialogFooter>
          </form>
        </DialogPanel>
      </DialogContainer>
    </Dialog>
  );
}
