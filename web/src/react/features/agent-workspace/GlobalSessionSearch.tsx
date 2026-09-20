import { useCallback, useEffect, useId, useRef, useState } from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import { Search, X, MessageSquare } from "lucide-react";
import { useShellStore } from "../../state/shellStore";
import { useLocale } from "../../../hooks/useLocale";
import { DialogOverlay } from "../../components/DialogOverlay";
import { useDialogFocus } from "../../components/directory-picker/useDialogFocus";
import { useSessionSearch } from "./useSessionSearch";
import { SearchHighlight } from "./SearchHighlight";
import { getSessionDisplayTitle } from "./useSessionDisplayTitle";
import { isWorkflowSession } from "./sessionBuckets";
import { sessionPath, workflowSessionPath } from "./sessionRoutes";
import { useAgentSessionStore } from "./state/agentSessionStore";
import type { AgentSession } from "../../../lib/api/agentRuntime";
import "./globalSessionSearch.css";

export function GlobalSessionSearch() {
  const location = useLocation();
  const currentProjectId = useShellStore((s) => s.currentProjectId);
  const projectId =
    matchPath("/projects/:projectId/*", location.pathname)?.params.projectId ??
    currentProjectId ??
    "";
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    setOpen(false);
  }, [location.key]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "f" ||
        event.isComposing
      )
        return;
      event.preventDefault();
      // Capture before editors/terminal consume the application shortcut.
      event.stopPropagation();
      setOpen(true);
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
  return open ? (
    <SearchDialog
      key={projectId}
      projectId={projectId}
      inputRef={inputRef}
      onClose={close}
    />
  ) : null;
}

function SearchDialog({
  projectId,
  inputRef,
  onClose,
}: {
  projectId: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onClose: () => void;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const navigate = useNavigate();
  const projectName = useShellStore(
    (s) => s.projects.find((project) => project.id === projectId)?.name,
  );
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const search = useSessionSearch(projectId, query);
  const dialogRef = useDialogFocus(onClose);
  const id = useId();
  const selectedIndex = Math.min(activeIndex, search.items.length - 1);
  useEffect(() => {
    const option = dialogRef.current?.querySelector<HTMLElement>(
      '[aria-selected="true"]',
    );
    option?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex, search.items, dialogRef]);
  const openSession = (session: AgentSession) => {
    useAgentSessionStore.getState().markSessionRead(session.id);
    navigate(
      isWorkflowSession(session)
        ? workflowSessionPath(session.projectId, session.id)
        : sessionPath(session.projectId, session.id),
    );
    onClose();
  };
  return (
    <DialogOverlay
      className="global-session-search-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog-content global-session-search"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
      >
        <div className="global-session-search-heading">
          <div>
            <h2 id={`${id}-title`}>
              {zh ? "搜索会话" : "Search conversations"}
            </h2>
            <p>{projectName || (zh ? "当前工作区" : "Current workspace")}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={zh ? "关闭搜索" : "Close search"}
          >
            <X size={18} />
          </button>
        </div>
        <div className="global-session-search-input">
          <Search size={19} aria-hidden="true" />
          <input
            ref={inputRef}
            data-dialog-autofocus
            role="combobox"
            aria-label={zh ? "搜索会话全文" : "Search conversation text"}
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={`${id}-results`}
            aria-activedescendant={
              selectedIndex >= 0 ? `${id}-result-${selectedIndex}` : undefined
            }
            placeholder={
              zh ? "搜索标题和历史消息…" : "Search titles and message history…"
            }
            value={query}
            maxLength={256}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229)
                return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (search.items.length)
                  setActiveIndex(
                    (selectedIndex +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      search.items.length) %
                      search.items.length,
                  );
              } else if (event.key === "Enter") {
                event.preventDefault();
                const item = search.items[selectedIndex];
                if (item) openSession(item.session);
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div
          className="global-session-search-results"
          onScroll={(event) => {
            const element = event.currentTarget;
            if (
              element.scrollHeight - element.scrollTop - element.clientHeight <
                80 &&
              search.hasMore &&
              !search.loading
            )
              void search.loadMore();
          }}
        >
          <div
            id={`${id}-results`}
            role="listbox"
            aria-label={zh ? "会话搜索结果" : "Conversation search results"}
            aria-busy={search.loading}
          >
            {search.items.map((item, index) => (
              <div
                key={item.session.id}
                id={`${id}-result-${index}`}
                role="option"
                aria-selected={selectedIndex === index}
                className="global-session-search-result"
                onMouseMove={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => openSession(item.session)}
              >
                <MessageSquare size={16} aria-hidden="true" />
                <div>
                  <div className="global-session-search-result-title">
                    <SearchHighlight
                      text={getSessionDisplayTitle(item.session, "", locale)}
                      query={search.query}
                    />
                  </div>
                  <p>
                    <SearchHighlight text={item.snippet} query={search.query} />
                  </p>
                </div>
              </div>
            ))}
          </div>
          {!projectId ? (
            <p className="global-session-search-status">
              {zh ? "请先打开一个工作区" : "Open a workspace to search"}
            </p>
          ) : !query.trim() ? (
            <p className="global-session-search-status">
              {zh
                ? "输入关键字，检索当前工作区的会话全文"
                : "Enter a keyword to search this workspace’s conversations"}
            </p>
          ) : search.loading ? (
            <p role="status" className="global-session-search-status">
              {zh ? "正在搜索…" : "Searching…"}
            </p>
          ) : !search.error && search.items.length === 0 ? (
            <p role="status" className="global-session-search-status">
              {zh ? "没有找到匹配的会话" : "No matching conversations"}
            </p>
          ) : null}
          {search.error && (
            <div role="alert" className="global-session-search-status">
              <p>{search.error}</p>
              <button type="button" onClick={search.refresh}>
                {zh ? "重试" : "Retry"}
              </button>
            </div>
          )}
          {search.hasMore && (
            <button
              type="button"
              className="global-session-search-more"
              disabled={search.loading}
              onClick={() => void search.loadMore()}
            >
              {zh ? "加载更多" : "Load more"}
            </button>
          )}
        </div>
        <div className="global-session-search-footer">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> {zh ? "选择" : "Select"}
          </span>
          <span>
            <kbd>↵</kbd> {zh ? "打开会话" : "Open conversation"}
          </span>
        </div>
      </div>
    </DialogOverlay>
  );
}
