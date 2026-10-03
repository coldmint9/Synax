import { useState } from "react";
import { Button } from "@/shared/ui/ui/Button";
import { FileCode } from "lucide-react";
import { configApi } from "../../../adapters/transport/config";
import { useLocale } from "../../../shared/hooks/useLocale";

export function OpenConfigFile() {
  const { t } = useLocale();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setOpening(true);
    setError(null);
    try {
      await configApi.openGlobalFile();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="mt-8 border-t border-border pt-6">
      <Button size="sm" variant="secondary" disabled={opening} onClick={open}>
        <FileCode size={13} />
        {t("settingsOpenConfigFile")}
      </Button>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        {t("settingsOpenConfigFileDesc")}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
