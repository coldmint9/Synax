import { useRef, useState } from "react";
import { ListBox, Popover } from "@heroui/react";
import "../agentControls.css";
import { ChevronDown, LoaderCircle, Shield } from "lucide-react";
import { useLocale } from "../../../../hooks/useLocale";
import { SYNAX_PERMISSION_TIER_LABELS } from "../synaxSessionTypes";
import type { SynaxPermissionTier } from "./composerTypes";

const ORDER: SynaxPermissionTier[] = ["boundary", "auto", "unrestricted"];
interface Props {
  sessionId?: string;
  value: SynaxPermissionTier;
  onChange: (value: SynaxPermissionTier) => void | Promise<void>;
  disabled?: boolean;
  backendId?: string;
}

export function ComposerPermissionPicker({
  sessionId,
  value,
  onChange,
  disabled,
  backendId,
}: Props) {
  const { locale, t } = useLocale();
  const zh = locale === "zh";
  const scope = useRef({ sessionId });
  if (scope.current.sessionId !== sessionId) scope.current = { sessionId };
  const [state, setState] = useState<{
    scope: typeof scope.current;
    pending: boolean;
    error: string | null;
  }>({ scope: scope.current, pending: false, error: null });
  const [openScope, setOpenScope] = useState<typeof scope.current | null>(null);
  const pending = state.scope === scope.current && state.pending;
  const error = state.scope === scope.current ? state.error : null;
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
      <Popover
        isOpen={!disabled && !pending && openScope === scope.current}
        onOpenChange={(open) =>
          setOpenScope(open && !disabled && !pending ? scope.current : null)
        }
      >
        <Popover.Trigger<"button">
          render={(props) => <button {...props} type="button" />}
          aria-label={zh ? "审批模式" : "Approval mode"}
          aria-description={description}
          disabled={disabled || pending}
          data-tier={value}
          className="agent-permission-cycle agent-dock-composer-chip agent-mode-trigger"
          title={description}
        >
          {pending ? (
            <LoaderCircle
              size={12}
              className="bui-status-spinner"
              aria-hidden
            />
          ) : (
            <Shield size={12} aria-hidden />
          )}
          <span>
            {t(
              SYNAX_PERMISSION_TIER_LABELS[value].titleKey as Parameters<
                typeof t
              >[0],
            )}
          </span>
          <ChevronDown size={10} aria-hidden />
        </Popover.Trigger>
        <Popover.Content
          placement="top start"
          offset={8}
          className="agent-mode-popover agent-workflow-popover"
        >
          <ListBox
            autoFocus
            aria-label={zh ? "审批模式" : "Approval mode"}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={new Set([value])}
            onSelectionChange={async (keys) => {
              if (disabled || pending || keys === "all") return;
              const tier = ORDER.find((item) => keys.has(item));
              if (!tier) return;
              setOpenScope(null);
              if (tier === value) return;
              const requestScope = scope.current;
              setState({ scope: requestScope, pending: true, error: null });
              try {
                await onChange(tier);
              } catch (err) {
                if (scope.current === requestScope)
                  setState({
                    scope: requestScope,
                    pending: false,
                    error: err instanceof Error ? err.message : String(err),
                  });
              } finally {
                if (scope.current === requestScope)
                  setState((previous) => ({ ...previous, pending: false }));
              }
            }}
          >
            {ORDER.map((tier) => (
              <ListBox.Item
                key={tier}
                id={tier}
                textValue={t(
                  SYNAX_PERMISSION_TIER_LABELS[tier].titleKey as Parameters<
                    typeof t
                  >[0],
                )}
                className="agent-mode-option agent-mode-option--workflow"
              >
                <Shield size={17} aria-hidden />
                <span className="agent-mode-option-copy">
                  <strong>
                    {t(
                      SYNAX_PERMISSION_TIER_LABELS[tier].titleKey as Parameters<
                        typeof t
                      >[0],
                    )}
                  </strong>
                  <small>
                    {t(
                      SYNAX_PERMISSION_TIER_LABELS[tier].descKey as Parameters<
                        typeof t
                      >[0],
                    )}
                  </small>
                </span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Popover.Content>
      </Popover>
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
