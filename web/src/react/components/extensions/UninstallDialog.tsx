import { AlertDialog, DialogContainer, DialogPanel, DialogHeader, DialogIcon, DialogTitle, DialogBody, DialogFooter } from "@/react/components/ui/Dialog";
import { Button } from "@/react/components/ui/Button";
import { useLocale } from '../../../hooks/useLocale'

export function UninstallDialog({
  name,
  description,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  name: string | null
  description: string
  busy: boolean
  error?: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useLocale()
  return (
    <AlertDialog
      open={name !== null}
      onClose={() => { if (!busy) onCancel(); }}
      dismissible={!busy}

    >
      <DialogContainer>
        <DialogPanel className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogIcon tone="danger" />
            <DialogTitle>
              {t('extensionUninstallTitle', { name: name ?? '' })}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm text-muted-foreground">{description}</p>
            {error && (
              <p role="alert" className="mt-3 text-sm text-danger">
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="tertiary" disabled={busy} onClick={onCancel}>
              {t('commonCancel')}
            </Button>
            <Button variant="danger" pending={busy} onClick={onConfirm}>
              {t('skillMarketUninstall')}
            </Button>
          </DialogFooter>
        </DialogPanel>
      </DialogContainer>
    </AlertDialog>
  )
}
