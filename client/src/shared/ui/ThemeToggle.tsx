import { Tooltip } from "./ui/Tooltip";
import { Moon, Sun } from "lucide-react";
import { useThemeStore } from "../state/themeStore";
import { useLocale } from "../hooks/useLocale";

/** One click toggles the visible theme, including when following the system. */
export function ThemeToggle() {
  const { locale } = useLocale();
  const dark = useThemeStore((s) => s.resolvedTheme === "dark");
  const setMode = useThemeStore((s) => s.setMode);
  const label =
    locale === "zh"
      ? dark
        ? "切换到浅色模式"
        : "切换到深色模式"
      : dark
        ? "Switch to light mode"
        : "Switch to dark mode";
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className="wh-btn"
        aria-label={label}
        onClick={() => setMode(dark ? "light" : "dark")}
      >
        {dark ? <Sun size={15} /> : <Moon size={15} />}
      </button>
    </Tooltip>
  );
}
