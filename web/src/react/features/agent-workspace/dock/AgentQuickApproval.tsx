import { useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  ShieldCheck,
  X,
} from "lucide-react";
import { useLocale } from "../../../../hooks/useLocale";
import type { PermissionDecision } from "../../../../lib/api/agentRuntime";
import { ActivityStatus } from "../../../components/beautiful-ui/ActivityStatus";

export function listPendingPermissions(
  permissions: PermissionDecision[],
): PermissionDecision[] {
  return permissions.filter((p) => p.action === "ask" && !p.resolvedAt);
}

type Reply = "once" | "always" | "reject";
type ReplyHandler = (
  permissionId: string,
  reply: Reply,
) => void | Promise<void>;
interface ActionsProps {
  permissionId: string;
  onReply: ReplyHandler;
  size?: "mini" | "strip";
  allowedReplies?: unknown;
}

export function AgentQuickApprovalActions({
  permissionId,
  onReply,
  size = "mini",
  allowedReplies,
}: ActionsProps) {
  const { t, locale } = useLocale();
  const [pending, setPending] = useState<Reply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const isMini = size === "mini";
  const supports = (reply: Reply) =>
    !Array.isArray(allowedReplies) || allowedReplies.includes(reply);

  async function reply(choice: Reply) {
    if (locked.current || !supports(choice)) return;
    locked.current = true;
    setPending(choice);
    setError(null);
    try {
      await onReply(permissionId, choice);
      // Keep the resolved request locked until its replacement arrives from the server.
    } catch (err) {
      locked.current = false;
      setPending(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div
      className="bui-approval-action-area"
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="bui-approval-actions"
        data-size={size}
        aria-busy={pending !== null}
      >
        {supports("once") && (
          <button
            type="button"
            className="bui-approval-button bui-approval-button--primary"
            disabled={pending !== null}
            aria-label={t("permAllowOnce")}
            onClick={() => void reply("once")}
          >
            {pending === "once" ? (
              <LoaderCircle
                size={14}
                className="bui-status-spinner"
                aria-hidden
              />
            ) : (
              <Check size={14} aria-hidden />
            )}
            {!isMini && t("permAllowOnce")}
          </button>
        )}
        {supports("always") && (
          <button
            type="button"
            className="bui-approval-button"
            disabled={pending !== null}
            aria-label={t("permAlwaysAllow")}
            title={t("permAlwaysAllowHint")}
            onClick={() => void reply("always")}
          >
            {pending === "always" && (
              <LoaderCircle
                size={14}
                className="bui-status-spinner"
                aria-hidden
              />
            )}
            {!isMini && t("permAlwaysAllow")}
            {isMini && <ShieldCheck size={14} aria-hidden />}
          </button>
        )}
        {supports("reject") && (
          <button
            type="button"
            className="bui-approval-button bui-approval-button--reject"
            disabled={pending !== null}
            aria-label={t("permReject")}
            onClick={() => void reply("reject")}
          >
            {pending === "reject" ? (
              <LoaderCircle
                size={14}
                className="bui-status-spinner"
                aria-hidden
              />
            ) : (
              <X size={14} aria-hidden />
            )}
            {!isMini && t("permReject")}
          </button>
        )}
      </div>
      {pending && (
        <span role="status" className="bui-approval-feedback">
          {locale === "zh" ? "正在提交决定…" : "Submitting decision…"}
        </span>
      )}
      {error && (
        <p role="alert" className="bui-approval-error">
          {error}
        </p>
      )}
    </div>
  );
}

interface Props {
  permissions: PermissionDecision[];
  onReply: ReplyHandler;
  variant?: "mini" | "strip";
  showIndicator?: boolean;
  onLabelClick?: () => void;
  className?: string;
}

export function AgentQuickApproval({
  permissions,
  onReply,
  variant = "strip",
  showIndicator = false,
  onLabelClick,
  className = "",
}: Props) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pending = listPendingPermissions(permissions);
  if (!pending.length) return null;
  const index = Math.max(
    0,
    pending.findIndex((item) => item.id === selectedId),
  );
  const permission = pending[index];
  const args = permission.metadata?.args as Record<string, unknown> | undefined;
  const command = permission.metadata?.command ?? args?.command;
  const approvalPaths = Array.isArray(permission.metadata?.approvalPaths)
    ? permission.metadata.approvalPaths.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const targets = approvalPaths.length ? approvalPaths : permission.patterns;
  const nativeTitle = permission.metadata?.acpTitle;
  const label =
    typeof command === "string"
      ? command
      : typeof nativeTitle === "string"
        ? nativeTitle
        : typeof args?.url === "string"
          ? args.url
          : targets.join(", ") || permission.reason;
  const workdir = args?.workdir;
  const isMini = variant === "mini";
  const scope =
    permission.internalGate === "external_path"
      ? zh
        ? "工作区外文件"
        : "External files"
      : permission.internalGate === "network"
        ? zh
          ? "网络访问"
          : "Network access"
        : typeof command === "string"
          ? zh
            ? "运行命令"
            : "Run command"
          : String(
              permission.metadata?.toolId ??
                (zh ? "工具操作" : "Tool operation"),
            );

  return (
    <section
      className={`bui-approval ${className}`}
      data-variant={variant}
      aria-label={zh ? "操作审批" : "Operation approval"}
    >
      {!isMini && (
        <header className="bui-approval-heading">
          <span className="bui-approval-heading-icon">
            <ShieldCheck size={16} aria-hidden />
          </span>
          <div>
            <strong>{zh ? "需要你的批准" : "Your approval is needed"}</strong>
            <span>{scope}</span>
          </div>
          {pending.length > 1 && (
            <nav
              className="bui-approval-queue"
              aria-label={zh ? "待审批队列" : "Approval queue"}
            >
              <button
                type="button"
                aria-label={zh ? "上一项审批" : "Previous approval"}
                disabled={index === 0}
                onClick={() => setSelectedId(pending[index - 1].id)}
              >
                <ChevronLeft size={14} aria-hidden />
              </button>
              <span aria-live="polite">
                {index + 1} / {pending.length}
              </span>
              <button
                type="button"
                aria-label={zh ? "下一项审批" : "Next approval"}
                disabled={index === pending.length - 1}
                onClick={() => setSelectedId(pending[index + 1].id)}
              >
                <ChevronRight size={14} aria-hidden />
              </button>
            </nav>
          )}
        </header>
      )}
      {isMini && showIndicator && (
        <ActivityStatus status="waiting_permission" compact />
      )}
      <div className="bui-approval-operation">
        {onLabelClick ? (
          <button
            type="button"
            className="bui-approval-command"
            onClick={onLabelClick}
          >
            {label}
          </button>
        ) : (
          <pre className="bui-approval-command">{label}</pre>
        )}
        {!isMini && typeof workdir === "string" && (
          <p className="bui-approval-scope">{workdir}</p>
        )}
      </div>
      {!isMini && (
        <div className="bui-approval-context">
          <p>{permission.reason}</p>
          <details key={permission.id} className="bui-approval-details">
            <summary>{zh ? "查看操作详情" : "View operation details"}</summary>
            <pre>
              {JSON.stringify(
                {
                  tool: permission.metadata?.toolId,
                  targets: permission.patterns,
                  ...(approvalPaths.length
                    ? { resolvedTargets: approvalPaths }
                    : {}),
                  ...(args ?? {}),
                },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
      )}
      <AgentQuickApprovalActions
        key={permission.id}
        permissionId={permission.id}
        onReply={onReply}
        allowedReplies={permission.metadata?.allowedReplies}
        size={isMini ? "mini" : "strip"}
      />
    </section>
  );
}
