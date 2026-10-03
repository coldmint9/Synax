import { Dialog, DialogContainer, DialogPanel, DialogHeader, DialogIcon, DialogTitle, DialogBody, DialogFooter } from "@/shared/ui/ui/Dialog";
import { Button } from "@/shared/ui/ui/Button";
import { Archive } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";

interface Props {
  isOpen: boolean;
  sessionTitle: string;
  isDeleting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function SessionDeleteDialog({
  isOpen,
  sessionTitle,
  isDeleting,
  onConfirm,
  onClose,
}: Props) {
  const { t } = useLocale();
  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
    >
      <DialogContainer size="sm">
        <DialogPanel>
          <DialogHeader>
            <DialogIcon>
              <Archive size={18} />
            </DialogIcon>
            <DialogTitle>{t("sessionDelete")}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {t("sessionDeleteConfirm", { title: sessionTitle })}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose} size="sm">
              {t("commonCancel")}
            </Button>
            <Button
              variant="primary"
              onClick={onConfirm}
              pending={isDeleting}
              size="sm"
            >
              {t("sessionDelete")}
            </Button>
          </DialogFooter>
        </DialogPanel>
      </DialogContainer>
    </Dialog>
  );
}
