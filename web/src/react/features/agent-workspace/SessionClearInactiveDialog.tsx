import { Button, Modal } from "@heroui/react";
import { Archive } from "lucide-react";
import { useState } from "react";
import { agentRuntimeApi } from "../../../lib/api/agentRuntime";
import { useLocale } from "../../../hooks/useLocale";

interface Props {
  isOpen: boolean;
  projectId: string | null;
  onClose: () => void;
  onCleared: () => void;
}

export function SessionClearInactiveDialog({
  isOpen,
  projectId,
  onClose,
  onCleared,
}: Props) {
  const { locale, t } = useLocale();
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleArchive = async () => {
    if (!projectId) return;
    setError(null);
    setArchiving(true);
    try {
      await agentRuntimeApi.clearInactiveSessions(projectId);
      onClose();
      onCleared();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sessionDeleteFailed"));
      console.error("[ArchiveInactive]", err);
    } finally {
      setArchiving(false);
    }
  };

  return (
    <Modal.Backdrop
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Container size="sm">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Icon><Archive size={18} /></Modal.Icon>
            <Modal.Heading>{t("sessionClearInactive")}</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <p>
              {locale === "zh"
                ? "归档当前工作区中所有未运行的会话？归档后的会话可在设置中恢复。"
                : "Archive all non-running sessions in this workspace? Archived sessions can be restored from Settings."}
            </p>
            {error && <p className="mt-2 text-xs text-danger">{error}</p>}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" onPress={onClose} size="sm">
              {t("commonCancel")}
            </Button>
            <Button
              variant="primary"
              onPress={handleArchive}
              isPending={archiving}
              isDisabled={!projectId}
              size="sm"
            >
              {locale === "zh" ? "全部归档" : "Archive all"}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
