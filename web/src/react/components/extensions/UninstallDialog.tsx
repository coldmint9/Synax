import { AlertDialog, Button } from '@heroui/react'
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
    <AlertDialog.Backdrop
      isOpen={name !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel()
      }}
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
    >
      <AlertDialog.Container>
        <AlertDialog.Dialog className="sm:max-w-[420px]">
          <AlertDialog.Header>
            <AlertDialog.Icon status="danger" />
            <AlertDialog.Heading>
              {t('extensionUninstallTitle', { name: name ?? '' })}
            </AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p className="text-sm text-muted-foreground">{description}</p>
            {error && (
              <p role="alert" className="mt-3 text-sm text-danger">
                {error}
              </p>
            )}
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button variant="tertiary" isDisabled={busy} onPress={onCancel}>
              {t('commonCancel')}
            </Button>
            <Button variant="danger" isPending={busy} onPress={onConfirm}>
              {t('skillMarketUninstall')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  )
}
