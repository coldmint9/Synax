import { useId, useState, type ReactNode } from "react";
import { Button } from "@heroui/react";
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
  className,
}: {
  icon: ReactNode;
  title: string;
  count?: number;
  summary?: string | null;
  actions?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
          onPress={() => setOpen((value) => !value)}
        >
          <span className="ws-card-icon">{icon}</span>
          <span className="ws-card-title">{title}</span>
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
