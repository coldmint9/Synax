import { useId, type ReactNode } from "react";
import { Button } from "@/shared/ui/ui/Button";
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
  collapsible = true,
  dormant = false,
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
  /** Render a static heading and ignore saved collapse state. */
  collapsible?: boolean;
  /** Nothing to disclose yet: the section stays collapsed with no expander. */
  dormant?: boolean;
}) {
  const [disclosed, toggle] = useWorkspaceDisclosure(storageKey, defaultOpen);
  const open = !dormant && (!collapsible || disclosed);
  const id = useId();
  return (
    <section
      className={`ws-card${className ? ` ${className}` : ""}`}
      data-open={open ? "true" : "false"}
      data-dormant={dormant ? "true" : "false"}
    >
      <div className="ws-card-head">
        {collapsible ? <Button
          variant="ghost"
          size="sm"
          className="ws-card-toggle"
          aria-expanded={open}
          aria-controls={id}
          aria-label={hideTitle ? title : undefined}
          disabled={dormant}
          onClick={toggle}
        >
          <span className="ws-card-icon">{icon}</span>
          {!hideTitle && <span className="ws-card-title">{title}</span>}
          {count !== undefined && (
            <span className="ws-card-count">{count}</span>
          )}
          {!dormant && (
            <ChevronDown size={11} className="ws-card-chevron" aria-hidden />
          )}
        </Button> : (
          <h3 className="ws-card-heading">
            <span className="ws-card-icon" aria-hidden="true">{icon}</span>
            <span className="ws-card-title">{title}</span>
          </h3>
        )}
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
