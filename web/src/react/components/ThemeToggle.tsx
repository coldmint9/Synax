import { Moon, Sun } from "lucide-react";
import { useShellStore } from "../state/shellStore";
import { useLocale } from "../../hooks/useLocale";

/** One click toggles the visible theme, including when following the system. */
export function ThemeToggle() {
  const { locale } = useLocale();
  const dark = useShellStore((s) => s.resolvedTheme === "dark");
  const setTheme = useShellStore((s) => s.setTheme);
  const label =
    locale === "zh"
      ? dark
        ? "切换到浅色模式"
        : "切换到深色模式"
      : dark
        ? "Switch to light mode"
        : "Switch to dark mode";
  return (
    <button
      type="button"
      className="wh-btn"
      title={label}
      aria-label={label}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {dark ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}
