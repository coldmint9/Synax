import { useId, useMemo } from "react";
import { Button } from "@/shared/ui/ui/Button";
import { IslandSelection } from "../IslandSelection";
import { useLocale } from "../../../shared/hooks/useLocale";
import { TOOLBAR_NAV_ITEMS } from "./toolbarNavItems";
import { useToolbarRovingFocus } from "./useToolbarRovingFocus";
import { useGitUnpushed } from "./useGitUnpushed";
import { GitUnpushedBadge, gitUnpushedDescription } from "./GitUnpushedBadge";
import type { ActivityPanel } from "../ActivityBar";

export interface WorkbenchNavProps {
  activePanel: ActivityPanel | null;
  hasProject: boolean;
  /** Workspace whose checkout feeds the unpushed badge; null without a project. */
  projectId: string | null;
  /** Session checkout (possibly a worktree) that owns the Git facts. */
  sessionId?: string | null;
  onPanelToggle: (panel: ActivityPanel) => void;
}

/**
 * Primary panel switches. Work and Git need a workspace, so their disabled state
 * is derived, never stored. Unpushed commits stay attached to the Git switch
 * instead of owning a separate button.
 */
export function WorkbenchNav({
  activePanel,
  hasProject,
  projectId,
  sessionId = null,
  onPanelToggle,
}: WorkbenchNavProps) {
  const { t, locale } = useLocale();
  const items = TOOLBAR_NAV_ITEMS;
  const unpushed = useGitUnpushed(projectId, sessionId);
  const unpushedDescription = gitUnpushedDescription(unpushed, locale);
  const unpushedDescriptionId = useId();
  const { ref, onKeyDown } = useToolbarRovingFocus<HTMLElement>("horizontal");

  return (
    <nav
      ref={ref}
      onKeyDown={onKeyDown}
      aria-label={t("workspaceMainNav")}
      className="wh-tabs"
    >
      <IslandSelection activeKey={activePanel} className="wh-tabs-list">
        {items.map((item) => {
          const Icon = item.icon;
          const selected = activePanel === item.id;
          const git = item.id === "git";
          return (
            <Button
              key={item.id}
              data-island-option={item.id}
              data-toolbar-focus=""
              variant="ghost"
              size="sm"
              disabled={item.requiresWorkspace && !hasProject}
              aria-pressed={selected}
              aria-label={item.label}
              aria-describedby={git && unpushedDescription ? unpushedDescriptionId : undefined}
              onClick={() => onPanelToggle(item.id)}
              className={`wh-tab wh-tab--${item.id} ${selected ? "bg-primary/10 text-primary" : ""}`}
            >
              <Icon size={15} aria-hidden="true" />
              <span>{item.label}</span>
              {git ? <GitUnpushedBadge unpushed={unpushed} locale={locale} /> : null}
              {git && unpushedDescription ? (
                <span id={unpushedDescriptionId} className="wh-sr-only">
                  {unpushedDescription}
                </span>
              ) : null}
            </Button>
          );
        })}
      </IslandSelection>
    </nav>
  );
}
