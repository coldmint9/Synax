import { useCallback } from "react";
import { Settings2, Terminal as TerminalIcon } from "lucide-react";
import { ThemeToggle } from "../../../shared/ui/ThemeToggle";
import { useLocale } from "../../../shared/hooks/useLocale";
import { useTerminalStore } from "../../../features/terminal/terminalStore";
import type { ActivityPanel } from "../ActivityBar";
import { ToolbarIconButton } from "./ToolbarIconButton";

export interface WorkbenchActionsProps {
  activePanel: ActivityPanel | null;
  onPanelToggle: (panel: ActivityPanel) => void;
}

function TerminalButton() {
  const { locale } = useLocale();
  const open = useTerminalStore((state) => state.open);
  const toggle = useCallback(() => useTerminalStore.getState().toggle(), []);
  return (
    <ToolbarIconButton
      icon={TerminalIcon}
      label={locale === "zh" ? "终端" : "Terminal"}
      pressed={open}
      onClick={toggle}
    />
  );
}

/**
 * Action cluster. Unpushed Git work is not a menu here: it lives on the Git
 * switch in the navigation, next to the panel it belongs to.
 */
export function WorkbenchActions({ activePanel, onPanelToggle }: WorkbenchActionsProps) {
  const { t } = useLocale();
  const openSettings = useCallback(() => onPanelToggle("settings"), [onPanelToggle]);
  return (
    <>
      <TerminalButton />
      <ToolbarIconButton
        icon={Settings2}
        label={t("appSettings")}
        pressed={activePanel === "settings"}
        onClick={openSettings}
      />
      <ThemeToggle />
    </>
  );
}
