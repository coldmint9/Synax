import { Bot, GitMerge } from "lucide-react";
import type { ActivityPanel } from "../ActivityBar";

export type ToolbarIcon = typeof Bot;

/** A top-level panel switch. Labels are product names, so they stay literal. */
export interface ToolbarNavItem {
  readonly id: Extract<ActivityPanel, "sessions" | "git">;
  readonly label: string;
  readonly icon: ToolbarIcon;
  /** Panels that need a workspace; without one they render disabled. */
  readonly requiresWorkspace: boolean;
}

export const TOOLBAR_NAV_ITEMS: readonly ToolbarNavItem[] = Object.freeze([
  Object.freeze({
    id: "sessions",
    label: "Work",
    icon: Bot,
    requiresWorkspace: true,
  }),
  Object.freeze({
    id: "git",
    label: "Git",
    icon: GitMerge,
    requiresWorkspace: true,
  }),
]);
