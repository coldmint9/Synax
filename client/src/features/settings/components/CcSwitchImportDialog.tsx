import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContainer,
  DialogFooter,
  DialogHeader,
  DialogIcon,
  DialogPanel,
  DialogTitle,
} from "@/shared/ui/ui/Dialog";
import { Button, CloseButton } from "@/shared/ui/ui/Button";
import { Download } from "lucide-react";
import { useLocale } from "../../../shared/hooks/useLocale";
import { configApi } from "../../../adapters/transport/config";
import type {
  CcSwitchConflictKind,
  CcSwitchImportAction,
  CcSwitchImportItem,
  CcSwitchPreviewResponse,
} from "../../../shared/contracts/config";

interface CcSwitchImportDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful import so the provider list can refresh. */
  onImported: () => void | Promise<void>;
}

interface ImportResult {
  imported: CcSwitchImportAction[];
  skipped: CcSwitchImportAction[];
  warnings: string[];
}

/**
 * Imports the providers already configured in CC Switch.
 *
 * The API key never reaches this component: the store keeps them server-side,
 * and this dialog only sends the selected source keys.
 */
export function CcSwitchImportDialog({ open, onClose, onImported }: CcSwitchImportDialogProps) {
  const { t } = useLocale();
  const [preview, setPreview] = useState<CcSwitchPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [validate, setValidate] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const next = await configApi.previewCcSwitchProviders();
      setPreview(next);
      setSelected(next.items.filter((item) => item.selectable).map((item) => item.key));
    } catch (err) {
      setPreview(null);
      setSelected([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const items = preview?.items ?? [];
  const selectableItems = items.filter((item) => item.selectable);
  const canImport = selectableItems.length > 0;

  const conflictLabel = (kind: CcSwitchConflictKind) =>
    kind === "duplicate-id"
      ? t("llmImportConflictDuplicate")
      : kind === "same-endpoint"
        ? t("llmImportConflictEndpoint")
        : t("llmImportConflictNone");

  const toggle = (item: CcSwitchImportItem) => {
    if (!item.selectable) return;
    setSelected((current) =>
      current.includes(item.key)
        ? current.filter((key) => key !== item.key)
        : [...current, item.key],
    );
  };

  const toggleAll = () => {
    setSelected((current) =>
      current.length === selectableItems.length ? [] : selectableItems.map((item) => item.key),
    );
  };

  const submit = async () => {
    if (selected.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      const response = await configApi.importCcSwitchProviders({ keys: selected, validate });
      setResult({
        imported: response.imported,
        skipped: response.skipped,
        warnings: response.warnings,
      });
      await onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("llmImportFailed"));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogContainer>
        <DialogPanel className="sm:max-w-[560px]">
          <DialogCloseButton />
          <DialogHeader>
            <DialogIcon>
              <Download size={18} />
            </DialogIcon>
            <DialogTitle>{t("llmImportTitle")}</DialogTitle>
          </DialogHeader>

          <DialogBody className="space-y-3">
            {loading && <p className="settings-note">{t("llmImportLoading")}</p>}

            {!loading && preview && !preview.available && (
              <p className="settings-note">{t("llmImportUnavailable")}</p>
            )}

            {!loading && preview?.available && items.length === 0 && (
              <p className="settings-note">{t("llmImportEmpty")}</p>
            )}

            {!loading && items.length > 0 && !result && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected.length === selectableItems.length && selectableItems.length > 0}
                      onChange={toggleAll}
                      disabled={selectableItems.length === 0}
                    />
                    {t("llmImportSelectAll")}
                  </label>
                  <span>
                    {selected.length}/{selectableItems.length}
                  </span>
                </div>

                <ul className="settings-list">
                  {items.map((item) => (
                    <li key={item.key} className="settings-item p-2.5">
                      <label className="flex items-start gap-2.5">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={selected.includes(item.key)}
                          disabled={!item.selectable}
                          onChange={() => toggle(item)}
                          aria-label={`${item.label} (${item.appType})`}
                        />
                        <span className="min-w-0 flex-1 space-y-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-xs font-medium text-foreground">
                              {item.label}
                            </span>
                            <span className="settings-chip">{item.appType}</span>
                            <span className="settings-chip">{conflictLabel(item.conflict)}</span>
                          </span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {item.baseUrl}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            {t("llmImportModels", { count: item.declaredModels.length })}
                            {item.apiKeyMasked ? ` · ${item.apiKeyMasked}` : ""}
                          </span>
                          {!item.selectable && item.reason && (
                            <span className="block text-[11px] text-destructive">{item.reason}</span>
                          )}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>

                <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={validate}
                    onChange={(event) => setValidate(event.currentTarget.checked)}
                  />
                  {t("llmImportValidate")}
                </label>

                <p className="settings-note">{t("llmImportConsequence")}</p>
              </div>
            )}

            {error && <p className="text-[11px] text-destructive">{error}</p>}

            {result && (
              <div className="space-y-1">
                <p className="text-xs text-foreground">
                  {t("llmImportResult", {
                    imported: result.imported.length,
                    skipped: result.skipped.length,
                  })}
                </p>
                {result.warnings.map((warning) => (
                  <p key={warning} className="text-[11px] text-muted-foreground">
                    {warning}
                  </p>
                ))}
              </div>
            )}
          </DialogBody>

          <DialogFooter>
            {result || !canImport ? (
              <Button size="sm" onClick={onClose}>
                {t("llmImportClose")}
              </Button>
            ) : (
              <>
                <CloseButton variant="tertiary">{t("llmImportCancel")}</CloseButton>
                <Button
                  size="sm"
                  disabled={selected.length === 0}
                  pending={importing}
                  onClick={() => void submit()}
                >
                  {t("llmImportSubmit", { count: selected.length })}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogPanel>
      </DialogContainer>
    </Dialog>
  );
}
