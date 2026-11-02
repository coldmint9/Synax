import { WifiOff } from "lucide-react";
import { useLocale } from "../../../shared/hooks/useLocale";
import { Tooltip } from "@/shared/ui/ui/Tooltip";
import { useApiConnectivityStore } from "../../../shared/lib/apiConnectivity";

/** One red mark when the backend is unreachable; silent otherwise. */
export function BackendConnectionStatus() {
  const { locale } = useLocale();
  const browserOnline = useApiConnectivityStore((state) => state.browserOnline);
  const apiReachable = useApiConnectivityStore((state) => state.apiReachable);
  if (browserOnline && apiReachable !== "unreachable") return null;

  const label = locale === "zh" ? "后端服务已断联" : "Backend disconnected";
  return (
    <Tooltip content={label}>
      <span
        role="img"
        aria-label={label}
        title={label}
        className="workbench-header__connection-status text-danger"
      >
        <WifiOff size={14} aria-hidden="true" />
      </span>
    </Tooltip>
  );
}
