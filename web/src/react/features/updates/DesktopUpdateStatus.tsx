import { useId } from "react";
import { createPortal } from "react-dom";
import { Button, Spinner } from "@heroui/react";
import { ChevronDown, ChevronUp, Download, RotateCw } from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";
import { useDesktopUpdate } from "./DesktopUpdateProvider";
import type { UpdaterState } from "../../../lib/desktop-updates";

function phaseLabel(phase: UpdaterState["phase"], zh: boolean): string {
  const labels = {
    idle: ["尚未检查更新", "Not checked yet"],
    checking: ["正在检查更新…", "Checking for updates…"],
    current: ["当前已是最新版本", "Up to date"],
    available: ["准备下载…", "Preparing download…"],
    downloading: ["正在下载…", "Downloading…"],
    verifying: ["正在校验安装包…", "Verifying package…"],
    ready: ["安装包已缓存并校验", "Package cached and verified"],
    installing: ["正在安装…", "Installing…"],
    complete: ["更新完成", "Update complete"],
    error: ["更新失败", "Update failed"],
  };
  return labels[phase][zh ? 0 : 1];
}

export function DesktopUpdateStatus({
  className = "",
}: {
  className?: string;
}) {
  const update = useDesktopUpdate();
  const { locale } = useLocale();
  const zh = locale === "zh";
  if (!update || (!update.state && !update.error)) return null;
  const { state, requesting, error, check, install } = update;
  const phase = state?.phase ?? "error";
  const progress = Math.max(0, Math.min(1, state?.progress ?? 0));
  const percent = Math.floor(progress * 100);
  const busy = [
    "checking",
    "available",
    "downloading",
    "verifying",
    "installing",
  ].includes(phase);
  const showProgress = [
    "downloading",
    "verifying",
    "ready",
    "installing",
  ].includes(phase);
  const indeterminate = phase === "verifying" || phase === "installing";
  const transfer = state?.transfer;
  const size = transfer?.downloadSize ?? state?.size ?? 0;
  const downloadedBytes =
    transfer?.downloadedBytes ?? Math.round(progress * size);
  const statusLabel =
    phase === "downloading" && transfer
      ? transfer.mode === "differential"
        ? zh
          ? "正在差分下载…"
          : "Downloading changes…"
        : zh
          ? "正在全量下载…"
          : "Downloading full package…"
      : phaseLabel(phase, zh);
  const formatSize = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
  const failure = error || (phase === "error" ? state?.message : null);

  return (
    <div className={`min-w-0 space-y-3 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium">
          Synax {state?.availableVersion ?? state?.currentVersion}
        </span>
        <span
          role="status"
          className="flex items-center gap-2 text-muted-foreground"
        >
          {busy && <Spinner size="sm" />}
          {statusLabel}
        </span>
      </div>
      {showProgress && (
        <div className="space-y-2">
          <div
            role="progressbar"
            aria-label={zh ? "更新下载进度" : "Update download progress"}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={indeterminate ? undefined : percent}
            aria-valuetext={
              indeterminate ? phaseLabel(phase, zh) : `${percent}%`
            }
            className="h-2 w-full overflow-hidden rounded bg-default"
          >
            <div
              className={`h-full ${phase === "ready" ? "bg-success" : "bg-accent"} ${indeterminate ? "animate-pulse" : ""}`}
              style={{ width: `${indeterminate ? 100 : percent}%` }}
            />
          </div>
          <div className="flex justify-between gap-3 font-mono text-xs tabular-nums text-muted-foreground">
            <span>
              {formatSize(downloadedBytes)} / {formatSize(size)} MiB
            </span>
            <span>{percent}%</span>
          </div>
        </div>
      )}
      {transfer?.mode === "differential" && (
        <p className="text-xs text-muted-foreground">
          {zh ? "本地复用" : "Reused locally"}{" "}
          {formatSize(transfer.reusedBytes)} MiB
        </p>
      )}
      {transfer?.fallback && (
        <p className="text-xs text-muted-foreground">
          {zh
            ? "差分不可用，已改为全量下载"
            : "Differential unavailable; switched to full download"}
        </p>
      )}
      {failure && (
        <p role="alert" className="break-words text-xs text-danger">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {phase === "ready" ? (
          <Button
            type="button"
            size="sm"
            variant="primary"
            isDisabled={requesting}
            onPress={() => void install()}
          >
            <RotateCw size={14} />
            {zh ? "安装并重启" : "Install and restart"}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            isDisabled={busy || requesting}
            onPress={() => void check()}
          >
            <RotateCw size={14} />
            {phase === "error"
              ? zh
                ? "重试"
                : "Retry"
              : zh
                ? "检查更新"
                : "Check for updates"}
          </Button>
        )}
      </div>
    </div>
  );
}

export function DesktopUpdatePanel() {
  const update = useDesktopUpdate();
  const { locale } = useLocale();
  const bodyId = useId();
  const zh = locale === "zh";
  if (
    !update?.visible ||
    !update.state ||
    ["idle", "current", "complete"].includes(update.state.phase)
  )
    return null;
  const { minimized, setMinimized, state } = update;
  const label = minimized
    ? zh
      ? "展开更新进度"
      : "Expand update progress"
    : zh
      ? "收起更新进度"
      : "Minimize update progress";
  return createPortal(
    <section
      aria-label={zh ? "软件更新进度" : "Software update progress"}
      className="fixed bottom-4 right-4 z-[90] w-[360px] max-w-[calc(100vw-32px)] rounded-lg border border-border bg-surface p-4 text-foreground shadow-lg"
    >
      <header className="flex min-h-7 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
          <Download size={14} className="shrink-0" />
          <span className="truncate">
            {minimized
              ? `Synax ${state.availableVersion ?? state.currentVersion}`
              : zh
                ? "在线更新"
                : "Online updates"}
          </span>
          {minimized && (
            <span className="text-muted-foreground">
              {state.phase === "downloading"
                ? `${Math.floor(state.progress * 100)}%`
                : phaseLabel(state.phase, zh)}
            </span>
          )}
        </div>
        <button
          type="button"
          title={label}
          aria-label={label}
          aria-expanded={!minimized}
          aria-controls={bodyId}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-default"
          onClick={() => setMinimized(!minimized)}
        >
          {minimized ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </header>
      {!minimized && (
        <div id={bodyId} className="mt-3">
          <DesktopUpdateStatus />
        </div>
      )}
    </section>,
    document.body,
  );
}
