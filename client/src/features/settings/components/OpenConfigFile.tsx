import { InfoTooltip } from "@/shared/ui/ui/InfoTooltip";
import { useState } from "react";
import { Button } from "@/shared/ui/ui/Button";
import { FileCode } from "lucide-react";
import { configApi } from "../../../adapters/transport/config";
import { useLocale } from "../../../shared/hooks/useLocale";

export function OpenConfigFile() {
  const { t, locale } = useLocale();
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
    <div className="settings-open-config">
      <Button size="sm" variant="secondary" disabled={opening} onClick={open}>
        <FileCode size={13} />
        {t("settingsOpenConfigFile")}
      </Button>
      <InfoTooltip label={locale === "zh" ? "配置文件说明" : "About the config file"}>{t("settingsOpenConfigFileDesc")}</InfoTooltip>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
