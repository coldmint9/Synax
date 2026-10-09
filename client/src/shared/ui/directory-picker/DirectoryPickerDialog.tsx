import {
  Dialog,
  DialogContainer,
  DialogPanel,
  DialogTitle,
} from "../ui/Dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUp,
  Check,
  ChevronRight,
  Folder,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  listRemoteDirectories,
  type RemoteDirectoryListing,
} from "../../../adapters/transport/fs";
import { useLocale } from "../../hooks/useLocale";
import { Button } from "../ui/Button";
import "../../../features/workspace/workspaceProjects.css";

/**
 * Directory picker for paths on the runtime host, including local Electron hosts.
 *
 * `<input type="file" webkitdirectory>` hands the renderer file handles, never a
 * usable directory path, so the browser cannot fill the "absolute path" field
 * the way the desktop build can. The runtime host lists directories instead and
 * the picker returns the chosen absolute paths.
 */
export interface DirectoryPickerDialogProps {
  open: boolean;
  /** Directory to start from; falls back to the host home directory. */
  initialPath?: string;
  locationKind?: "host" | "wsl";
  distribution?: string;
  onClose: () => void;
  onSelect: (selection: { path: string; name: string }) => void;
  multiple?: boolean;
  onSelectMultiple?: (selections: { path: string; name: string }[]) => void;
  /** Override individual strings so localized callers can translate the dialog. */
  labels?: Partial<typeof defaultLabels>;
}

const defaultLabels = {
  title: "选择项目目录",
  hint: "以下目录位于运行 Synax 的机器上，文件内容不会被读取。",
  up: "上级目录",
  home: "主目录",
  refresh: "刷新",
  cancel: "取消",
  confirm: "选择此目录",
  confirmMultiple: "添加所选项目",
  select: "选择",
  selectCurrent: "选择当前目录",
  deselectCurrent: "取消选择当前目录",
  selectedCount: "已选择 {count} 个项目",
  empty: "该目录下没有子目录。",
  truncated: "目录过多，仅显示前 2000 项。",
  showHidden: "显示隐藏目录",
  showIgnored: "显示构建目录",
  path: "目录路径",
  search: "搜索当前目录",
  searchPlaceholder: "输入名称或路径快速筛选…",
  noMatches: "没有匹配的目录。",
  loading: "正在读取目录…",
  close: "关闭",
  failed: "读取目录失败",
  selectionHint: "勾选项目以加入工作区，点击文件夹名称进入目录。",
  removeSelection: "取消选择",
};

const englishLabels: typeof defaultLabels = {
  title: "Choose project directory",
  hint: "Browse directories on the machine running Synax.",
  up: "Parent directory",
  home: "Home",
  refresh: "Refresh",
  cancel: "Cancel",
  confirm: "Choose this directory",
  confirmMultiple: "Add selected projects",
  select: "Select",
  selectCurrent: "Select current directory",
  deselectCurrent: "Deselect current directory",
  selectedCount: "{count} projects selected",
  empty: "No subdirectories here.",
  truncated: "Showing the first 2000 directories.",
  showHidden: "Show hidden directories",
  showIgnored: "Show build directories",
  path: "Directory path",
  search: "Search this directory",
  searchPlaceholder: "Filter by name or path…",
  noMatches: "No matching directories.",
  loading: "Reading directories…",
  close: "Close",
  failed: "Failed to read directory",
  selectionHint:
    "Check projects to add them. Click a folder name to browse inside.",
  removeSelection: "Deselect",
};

/** Breadcrumb segments; each one is clickable to jump back up. */
function breadcrumbs(path: string): { name: string; path: string }[] {
  const separator = path.includes("\\") ? "\\" : "/";
  const parts = path.split(separator).filter(Boolean);
  const crumbs: { name: string; path: string }[] = [];
  let current = separator === "\\" ? "" : "";
  parts.forEach((part, index) => {
    current =
      index === 0 && separator === "/"
        ? `/${part}`
        : `${current}${current && current !== "/" ? separator : ""}${part}`;
    crumbs.push({ name: part, path: current });
  });
  return crumbs;
}

export function DirectoryPickerDialog({
  open,
  ...props
}: DirectoryPickerDialogProps) {
  // Each opening owns its selection, navigation and in-flight listing request.
  return open ? (
    <DirectoryPickerContent key={props.initialPath} {...props} />
  ) : null;
}

function DirectoryPickerContent({
  initialPath,
  locationKind = "host",
  distribution,
  onClose,
  onSelect,
  labels,
  multiple = false,
  onSelectMultiple,
}: Omit<DirectoryPickerDialogProps, "open">) {
  // Shadow the module default so every string below can be localized by the caller.
  const { locale } = useLocale();
  const label = {
    ...(locale === "en" ? englishLabels : defaultLabels),
    ...labels,
  };
  const [listing, setListing] = useState<RemoteDirectoryListing | null>(null);
  const [pathInput, setPathInput] = useState(initialPath ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const request = useRef<AbortController | null>(null);
  const [selected, setSelected] = useState<{ path: string; name: string }[]>(
    [],
  );
  const lastPath = useRef<string | undefined>(initialPath);
  const pathRef = useRef<HTMLInputElement>(null);
  const toggle = (entry: { path: string; name: string }) =>
    setSelected((items) =>
      items.some((item) => item.path === entry.path)
        ? items.filter((item) => item.path !== entry.path)
        : [...items, { path: entry.path, name: entry.name }],
    );

  const load = useCallback(
    async (target?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError(null);
      try {
        const next = await listRemoteDirectories(target, {
          showHidden,
          showIgnored,
          signal: controller.signal,
          locationKind,
          distribution,
        });
        if (controller.signal.aborted) return;
        setListing(next);
        lastPath.current = next.path;
        setPathInput(next.path);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [showHidden, showIgnored, locationKind, distribution],
  );

  useEffect(() => {
    void load(lastPath.current);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [load]);

  const current = listing?.path ?? "";
  const crumbs = current ? breadcrumbs(current) : [];
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const filteredEntries = (listing?.entries ?? []).filter((entry) => {
    if (!normalizedSearch) return true;
    return `${entry.name} ${entry.path}`
      .toLocaleLowerCase()
      .includes(normalizedSearch);
  });
  const activeEntry = filteredEntries[activeSearchIndex];

  return (
    <Dialog open onClose={onClose} initialFocus={pathRef}>
      <DialogContainer size="lg" className="max-w-[720px]!">
        <DialogPanel className="workspace-directory-picker min-h-0 min-w-0 gap-0! overflow-hidden max-h-[min(760px,calc(100dvh-24px))]! rounded-xl! bg-card! p-5! text-[13px] text-card-foreground sm:p-6! [&_button]:rounded-lg [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-offset-2 [&_button]:focus-visible:outline-ring">
          <div className="mb-4 flex shrink-0 items-start justify-between gap-3! border-b border-border pb-4">
            <div>
              <DialogTitle className="text-base font-semibold text-foreground">
                {label.title}
              </DialogTitle>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {multiple ? label.selectionHint : label.hint}
              </p>
            </div>
            <Button
              type="button"
              aria-label={label.close}
              variant="ghost"
              iconOnly
              className="text-muted-foreground"
              onClick={onClose}
            >
              <X size={16} />
            </Button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
            <label className="mb-3 block shrink-0">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                {label.path}
              </span>
              <div className="flex gap-2">
                <input
                  type="text"
                  ref={pathRef}
                  aria-label={label.path}
                  className="import-input min-h-[34px] min-w-0 flex-1 rounded-lg! border-border! bg-card! text-[13px]!"
                  value={pathInput}
                  onChange={(event) => setPathInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void load(pathInput.trim());
                    }
                  }}
                  placeholder="/path/to/project"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  aria-label={label.refresh}
                  className="min-h-[34px]"
                  disabled={loading || !pathInput.trim()}
                  onClick={() => void load(pathInput.trim())}
                >
                  <RefreshCw
                    size={12}
                    className={loading ? "animate-spin" : ""}
                  />
                  {label.refresh}
                </Button>
              </div>
            </label>

            <label className="workspace-directory-search min-h-[34px] rounded-lg! border-border! bg-card! [&_input]:text-[13px]!">
              <Search size={14} aria-hidden="true" />
              <span className="sr-only">{label.search}</span>
              <input
                type="search"
                aria-label={label.search}
                aria-controls="workspace-directory-results"
                aria-activedescendant={
                  normalizedSearch && activeEntry
                    ? `workspace-directory-entry-${activeSearchIndex}`
                    : undefined
                }
                value={searchQuery}
                placeholder={label.searchPlaceholder}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setActiveSearchIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActiveSearchIndex((index) =>
                      Math.min(
                        index + 1,
                        Math.max(filteredEntries.length - 1, 0),
                      ),
                    );
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveSearchIndex((index) => Math.max(index - 1, 0));
                  } else if (event.key === "Enter" && activeEntry) {
                    event.preventDefault();
                    void load(activeEntry.path);
                    setSearchQuery("");
                    setActiveSearchIndex(0);
                  } else if (event.key === "Escape") {
                    setSearchQuery("");
                    setActiveSearchIndex(0);
                  }
                }}
              />
              {searchQuery && (
                <button
                  type="button"
                  aria-label={label.close}
                  onClick={() => {
                    setSearchQuery("");
                    setActiveSearchIndex(0);
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </label>

            <div className="mb-3 flex shrink-0 items-center gap-1 overflow-x-auto whitespace-nowrap text-xs text-muted-foreground">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition hover:bg-muted/40 hover:text-foreground"
                onClick={() => void load(listing?.parent ?? undefined)}
                disabled={!listing?.parent}
                aria-label={label.up}
              >
                <ArrowUp size={11} />
                {label.up}
              </button>
              {listing?.home && (
                <button
                  type="button"
                  className="rounded-md px-1.5 py-0.5 transition hover:bg-muted/40 hover:text-foreground"
                  onClick={() => void load(listing.home)}
                >
                  {label.home}
                </button>
              )}
              {crumbs.length > 1 && (
                <span className="flex items-center gap-1">
                  {crumbs.map((crumb, index) => (
                    <span key={crumb.path} className="flex items-center gap-1">
                      {index > 0 && (
                        <span className="text-muted-foreground/40">/</span>
                      )}
                      <button
                        type="button"
                        className="max-w-[12rem] truncate rounded-md px-1 py-0.5 transition hover:bg-muted/40 hover:text-foreground"
                        title={crumb.path}
                        onClick={() => void load(crumb.path)}
                      >
                        {crumb.name}
                      </button>
                    </span>
                  ))}
                </span>
              )}
            </div>

            <div
              id="workspace-directory-results"
              className="min-h-32 flex-1 overflow-y-auto overscroll-contain rounded-[10px] border border-border bg-card [&_.workspace-directory-open]:text-[13px] [&_.workspace-directory-entry]:min-h-10"
              role="region"
              aria-label={label.title}
              aria-busy={loading}
            >
              {loading && (
                <p
                  className="flex min-h-32 items-center justify-center gap-2 px-4 py-6 text-xs text-muted-foreground"
                  role="status"
                >
                  <Loader2 size={13} className="animate-spin" />
                  {label.loading}
                </p>
              )}
              {error && (
                <p
                  role="alert"
                  className="m-3 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive"
                >
                  <AlertCircle
                    size={16}
                    aria-hidden="true"
                    className="mt-0.5 shrink-0"
                  />
                  <span className="min-w-0 break-words">{error}</span>
                </p>
              )}
              {!loading && !error && filteredEntries.length === 0 && (
                <p
                  className="flex min-h-32 flex-col items-center justify-center gap-2 px-4 py-6 text-center text-[13px] text-muted-foreground"
                  role="status"
                >
                  <Folder size={24} aria-hidden="true" />
                  {normalizedSearch ? label.noMatches : label.empty}
                </p>
              )}
              {!loading &&
                !error &&
                filteredEntries.map((entry, index) => (
                  <div
                    key={entry.path}
                    id={`workspace-directory-entry-${index}`}
                    className="workspace-directory-entry"
                    data-active={
                      index === activeSearchIndex && normalizedSearch
                        ? true
                        : undefined
                    }
                    data-selected={
                      selected.some((item) => item.path === entry.path) ||
                      undefined
                    }
                  >
                    {multiple && (
                      <input
                        type="checkbox"
                        aria-label={`${label.select} ${entry.name}`}
                        title={entry.path}
                        checked={selected.some(
                          (item) => item.path === entry.path,
                        )}
                        onChange={() => toggle(entry)}
                      />
                    )}
                    <button
                      type="button"
                      className="workspace-directory-open"
                      title={entry.path}
                      onClick={() => void load(entry.path)}
                    >
                      <Folder
                        size={13}
                        className={
                          entry.hidden
                            ? "text-muted-foreground/60"
                            : "text-muted-foreground"
                        }
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {entry.name}
                      </span>
                      <ChevronRight
                        size={12}
                        className="text-muted-foreground/50"
                      />
                    </button>
                  </div>
                ))}
              {!loading && !error && listing?.truncated && (
                <p className="border-t border-border bg-muted/40 px-3 py-2 text-xs text-warning">
                  {label.truncated}
                </p>
              )}
            </div>

            <div className="mt-3 flex shrink-0 flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(event) => setShowHidden(event.target.checked)}
                />
                {label.showHidden}
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={showIgnored}
                  onChange={(event) => setShowIgnored(event.target.checked)}
                />
                {label.showIgnored}
              </label>
              <span
                className="ml-auto min-w-0 truncate font-mono"
                title={current}
              >
                {current}
              </span>
            </div>
          </div>

          {multiple && selected.length > 0 && (
            <div
              className="workspace-directory-selection rounded-[10px] border border-border bg-muted/30 p-2 [&_button]:text-xs!"
              aria-label={label.selectedCount.replace(
                "{count}",
                String(selected.length),
              )}
            >
              {selected.map((item) => (
                <button
                  type="button"
                  key={item.path}
                  title={item.path}
                  aria-label={`${label.removeSelection} ${item.name}`}
                  onClick={() => toggle(item)}
                >
                  <Folder size={11} />
                  <span>{item.name}</span>
                  <X size={11} />
                </button>
              ))}
            </div>
          )}
          {multiple && (
            <div className="mt-3 flex shrink-0 items-center justify-between gap-2 text-xs">
              <span role="status">
                {label.selectedCount.replace(
                  "{count}",
                  String(selected.length),
                )}
              </span>
              <button
                type="button"
                disabled={!current || loading || Boolean(error)}
                onClick={() =>
                  toggle({ path: current, name: listing?.name || current })
                }
              >
                {selected.some((item) => item.path === current)
                  ? label.deselectCurrent
                  : label.selectCurrent}
              </button>
            </div>
          )}
          <div className="mt-4 flex shrink-0 flex-wrap justify-end gap-2! border-t border-border pt-4">
            <Button type="button" className="min-h-[34px]" onClick={onClose}>
              {label.cancel}
            </Button>
            <Button
              type="button"
              variant="primary"
              className="min-h-[34px]"
              disabled={
                multiple
                  ? selected.length === 0 || !onSelectMultiple
                  : !current || loading || Boolean(error)
              }
              onClick={() =>
                multiple
                  ? onSelectMultiple?.(selected)
                  : onSelect({ path: current, name: listing?.name || current })
              }
            >
              <Check size={12} />
              {multiple
                ? `${labels?.confirm ?? label.confirmMultiple} (${selected.length})`
                : label.confirm}
            </Button>
          </div>
        </DialogPanel>
      </DialogContainer>
    </Dialog>
  );
}
