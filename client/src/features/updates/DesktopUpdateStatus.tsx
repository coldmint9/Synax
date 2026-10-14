import { createPortal } from "react-dom";
import { Spinner } from "@/shared/ui/ui/Display";
import { Button } from "@/shared/ui/ui/Button";
import { ChevronDown, ChevronUp, Download, RotateCw } from "lucide-react";
import { Dialog, DialogContainer, DialogPanel, DialogTitle, DialogDescription } from "@/shared/ui/ui/Dialog";
import { useLocale } from "../../shared/hooks/useLocale";
import { useDesktopUpdate } from "./DesktopUpdateProvider";
import type { UpdaterState } from "../../adapters/electron/desktop-updates";

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
        {failure && (
          <a
            href="https://github.com/coldmint9/Synax/releases/latest"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent underline self-center"
          >
            {zh ? "打开发布页手动下载" : "Download from releases"}
          </a>
        )}
        {phase === "ready" ? (
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={requesting}
            onClick={() => void install()}
          >
            <RotateCw size={14} />
            {zh ? "安装并重启" : "Install and restart"}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy || requesting}
            onClick={() => void check()}
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
  const zh = locale === "zh";
  if (!update?.visible || (!update.state && !update.error)) return null;
  const { minimized, setMinimized, state, error, requesting, install, check } = update;
  const failure = error || (state?.phase === "error" ? state.message : null);
  const phase = failure ? "error" : state?.phase ?? "error";
  if (["idle", "current", "complete"].includes(phase)) return null;
  const ready = phase === "ready";
  const installing = phase === "installing";
  const busy = ["checking", "available", "downloading", "verifying", "installing"].includes(phase);
  const percent = ready ? 100 : Math.floor(Math.max(0, Math.min(1, state?.progress ?? 0)) * 100);
  const indeterminate = ["checking", "available", "verifying", "installing"].includes(phase);
  const title = ready ? (zh ? "更新已就绪" : "Update ready")
    : phase === "downloading" ? (zh ? "正在更新 Synax" : "Updating Synax")
    : phaseLabel(phase, zh);
  const version = state?.availableVersion ?? state?.currentVersion;

  if (minimized) return createPortal(
    <section aria-label={zh ? "软件更新进度" : "Software update progress"}
      className="fixed bottom-4 right-4 z-[90] flex w-[360px] max-w-[calc(100vw-32px)] items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 text-foreground shadow-lg">
      <div className="flex min-w-0 items-center gap-3 text-xs">
        <Download size={18} className="shrink-0 text-info" aria-hidden="true" />
        <div className="min-w-0">
          <p className="truncate font-medium">Synax {version}</p>
          <p role="status" className="mt-1 text-muted-foreground">
            {phase === "downloading" ? percent + "%" : title}
          </p>
        </div>
      </div>
      <Button size="sm" variant="ghost" aria-label={zh ? "展开更新进度" : "Expand update progress"}
        onClick={() => setMinimized(false)}><ChevronUp size={16} /></Button>
    </section>, document.body,
  );

  return (
    <Dialog open onClose={() => setMinimized(true)} dismissible={!installing} className="z-[90]">
      <DialogContainer size="lg">
        <DialogPanel
          role="region"
          aria-label={zh ? "软件更新进度" : "Software update progress"}
          className="!gap-0 !border-white/10 !bg-[#090909] !p-0 !text-white"
        >
          <header className="flex shrink-0 items-center justify-between px-6 py-4">
            <span className="text-xs text-white/50">Synax · {zh ? "在线更新" : "Online updates"}</span>
            <Button size="sm" variant="ghost" disabled={installing}
              className="!text-white/70 hover:!bg-white/10"
              aria-label={zh ? "收起更新进度" : "Minimize update progress"}
              onClick={() => setMinimized(true)}><ChevronDown size={16} />{zh ? "稍后继续" : "Continue later"}</Button>
          </header>
          <div className="flex min-h-0 flex-col items-center overflow-y-auto px-6 pb-12 pt-8 text-center sm:px-16 sm:pb-16 sm:pt-14">
            <div aria-hidden="true" className="relative mb-9 flex h-20 w-20 shrink-0 items-center justify-center">
              <div className={busy ? "absolute inset-0 rounded-full border-2 border-white/15 border-t-white motion-safe:animate-spin" : "absolute inset-0 rounded-full border border-white/20"} />
              <span className="text-3xl font-semibold">S</span>
            </div>
            <DialogTitle className="!text-xl">{title}</DialogTitle>
            <DialogDescription className="mt-3 !text-white/55">
              {ready ? (zh ? "重启以完成更新。重启会停止当前任务，请在任务完成后操作。" : "Restart to finish updating. Restarting stops current tasks; wait until they finish.")
                : failure ? (zh ? "无法完成更新，请重试或手动下载最新版本。" : "Could not finish updating. Retry or download the latest version.")
                : installing ? (zh ? "正在安装更新并重启 Synax…" : "Installing the update and restarting Synax…")
                : (zh ? "下载期间任务继续运行，你可以收起此窗口继续工作。" : "Your tasks keep running while downloading. Minimize to keep working.")}
            </DialogDescription>
            {!failure && (
              <div className="mt-9 w-full max-w-sm">
                <div role="progressbar" aria-label={zh ? "更新下载进度" : "Update download progress"}
                  aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : percent}
                  aria-valuetext={indeterminate ? title : percent + "%"}
                  className="h-2 overflow-hidden rounded-full bg-white/15">
                  <div className={"h-full rounded-full bg-[#1686ff] transition-[width] motion-reduce:transition-none " + (indeterminate ? "motion-safe:animate-pulse" : "")}
                    style={{ width: (indeterminate ? 100 : percent) + "%" }} />
                </div>
                <p role="status" className="mt-5 text-sm tabular-nums text-white/70">
                  {ready ? "Synax " + version : indeterminate ? title : percent + "%"}
                </p>
              </div>
            )}
            {failure && <p role="alert" className="mt-6 max-w-sm break-words text-sm text-red-300">{failure}</p>}
            {ready && <Button className="mt-8 !rounded-full !bg-white !px-6 !text-black hover:!bg-white/90"
              disabled={requesting} onClick={() => void install()}>{zh ? "更新并重启" : "Update and restart"}</Button>}
            {failure && <Button className="mt-8" disabled={requesting} onClick={() => void check()}>{zh ? "重试" : "Retry"}</Button>}
            {!installing && <a className="mt-7 text-sm text-white/50 underline underline-offset-4 hover:text-white focus-visible:outline focus-visible:outline-2"
              href="https://github.com/coldmint9/Synax/releases/latest" target="_blank" rel="noopener noreferrer">
              {zh ? "下载最新版本" : "Download latest version"}
            </a>}
          </div>
        </DialogPanel>
      </DialogContainer>
    </Dialog>
  );
}
