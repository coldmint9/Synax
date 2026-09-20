import { useState } from "react";
import { LoaderCircle, Shield } from "lucide-react";
import { useLocale } from "../../../../hooks/useLocale";
import { SYNAX_PERMISSION_TIER_LABELS } from "../synaxSessionTypes";
import type { SynaxPermissionTier } from "./composerTypes";

const ORDER: SynaxPermissionTier[] = ["boundary", "auto", "unrestricted"];
interface Props {
  value: SynaxPermissionTier;
  onChange: (value: SynaxPermissionTier) => void | Promise<void>;
  disabled?: boolean;
  backendId?: string;
}

export function ComposerPermissionPicker({
  value,
  onChange,
  disabled,
  backendId,
}: Props) {
  const { locale, t } = useLocale();
  const zh = locale === "zh";
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (backendId === "codex" || backendId === "claude-code") {
    const label = zh ? "CLI 原生审批" : "Native CLI approvals";
    return (
      <span
        role="note"
        aria-label={label}
        data-native-policy="true"
        className="agent-permission-cycle agent-dock-composer-chip inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px]"
      >
        <Shield size={12} aria-hidden />
        <span>{label}</span>
      </span>
    );
  }
  const description = `${t(SYNAX_PERMISSION_TIER_LABELS[value].descKey as Parameters<typeof t>[0])} · ${zh ? "下一步生效" : "Applies from the next step"}`;
  return (
    <div className="relative">
      <label
        data-tier={value}
        className="agent-permission-cycle agent-dock-composer-chip inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px]"
        title={description}
      >
        {pending ? (
          <LoaderCircle size={12} className="bui-status-spinner" aria-hidden />
        ) : (
          <Shield size={12} aria-hidden />
        )}
        <select
          aria-label={zh ? "审批模式" : "Approval mode"}
          value={value}
          disabled={disabled || pending}
          className="max-w-36 cursor-pointer bg-transparent text-inherit outline-offset-2"
          onChange={async (event) => {
            setPending(true);
            setError(null);
            try {
              await onChange(event.target.value as SynaxPermissionTier);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setPending(false);
            }
          }}
        >
          {ORDER.map((tier) => (
            <option key={tier} value={tier}>
              {t(
                SYNAX_PERMISSION_TIER_LABELS[tier].titleKey as Parameters<
                  typeof t
                >[0],
              )}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <span
          role="alert"
          className="absolute bottom-full right-0 mb-2 w-64 rounded-lg border border-border bg-surface p-2 text-xs text-danger shadow-sm"
        >
          {error}
        </span>
      )}
    </div>
  );
}
