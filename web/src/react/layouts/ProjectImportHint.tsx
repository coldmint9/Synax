import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { useLocale } from "../../hooks/useLocale";

const key = "synax:project-import-hint-dismissed";
export function ProjectImportHint({
  hasProject,
  onImport,
  targetActivated = false,
}: {
  hasProject: boolean;
  onImport: () => void;
  targetActivated?: boolean;
}) {
  const { locale } = useLocale();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(key) === "true";
    } catch {
      return false;
    }
  });
  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(key, "true");
    } catch {
      /* Storage may be unavailable. */
    }
  }, []);
  useEffect(() => {
    if (hasProject || targetActivated) dismiss();
  }, [hasProject, targetActivated, dismiss]);
  if (hasProject || targetActivated || dismissed) return null;
  return (
    <aside
      className="project-import-hint"
      aria-label={locale === "zh" ? "导入项目引导" : "Import a project"}
    >
      <svg
        className="project-import-hint-arrow"
        width="112"
        height="60"
        viewBox="0 0 112 60"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M100 56C43 58 26 38 30 4M22 14L30 4L38 13"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <button
        type="button"
        className="project-import-hint-close"
        onClick={dismiss}
        aria-label={locale === "zh" ? "关闭导入提示" : "Dismiss import hint"}
      >
        <X size={13} />
      </button>
      <strong>
        {locale === "zh" ? "从一个项目开始" : "Start with a project"}
      </strong>
      <p>
        {locale === "zh"
          ? "点击上方切换项目，导入本地目录。之后也可以在这里切换工作区。"
          : "Use the switcher above to import a local folder or change your workspace."}
      </p>
      <button
        type="button"
        className="project-import-hint-action"
        onClick={() => {
          dismiss();
          onImport();
        }}
      >
        {locale === "zh" ? "导入项目" : "Import project"}
      </button>
    </aside>
  );
}
