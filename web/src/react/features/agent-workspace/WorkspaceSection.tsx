import { useId, type ReactNode } from "react";
import { Button } from "@heroui/react";
import { useWorkspaceDisclosure } from "./useWorkspaceDisclosure";
import { ChevronDown } from "lucide-react";

/** Shared compact disclosure for the floating Work cards. */
export function WorkspaceSection({
  icon,
  title,
  count,
  summary,
  actions,
  toolbar,
  children,
  defaultOpen = true,
  storageKey,
  className,
  hideTitle = false,
}: {
  icon: ReactNode;
  title: string;
  count?: number;
  summary?: string | null;
  actions?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  storageKey?: string;
  className?: string;
  /** Keep the section collapsible but let the row carry only icon and metrics. */
  hideTitle?: boolean;
}) {
  const [open, toggle] = useWorkspaceDisclosure(storageKey, defaultOpen);
  const id = useId();
  return (
    <section
      className={`ws-card${className ? ` ${className}` : ""}`}
      data-open={open ? "true" : "false"}
    >
      <div className="ws-card-head">
        <Button
          variant="ghost"
          size="sm"
          className="ws-card-toggle"
          aria-expanded={open}
          aria-controls={id}
          aria-label={hideTitle ? title : undefined}
          onPress={toggle}
        >
          <span className="ws-card-icon">{icon}</span>
          {!hideTitle && <span className="ws-card-title">{title}</span>}
          {count !== undefined && (
            <span className="ws-card-count">{count}</span>
          )}
          <ChevronDown size={11} className="ws-card-chevron" aria-hidden />
        </Button>
        {(summary || actions) && (
          <div className="ws-card-tail">
            {summary && <span className="ws-card-summary">{summary}</span>}
            {actions}
          </div>
        )}
        {toolbar && <div className="ws-card-toolbar">{toolbar}</div>}
      </div>
      {open && (
        <div id={id} className="ws-card-body">
          {children}
        </div>
      )}
    </section>
  );
}
