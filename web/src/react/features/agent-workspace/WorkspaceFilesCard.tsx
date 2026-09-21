import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronRight, FileCode2 } from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";
import { useWorkspaceDisclosure } from "./useWorkspaceDisclosure";
import "./workspaceFilesCard.css";

type FileView = "inputs" | "outputs";

/** One disclosure and two views, shared by repository and standalone layouts. */
export function WorkspaceFilesCard({
  storageKey,
  embedded = false,
  inputCount,
  outputCount,
  inputs,
  outputs,
}: {
  storageKey: string;
  embedded?: boolean;
  inputCount: number;
  outputCount: number;
  inputs: ReactNode;
  outputs: ReactNode;
}) {
  const { t } = useLocale();
  const id = useId();
  const [open, toggle] = useWorkspaceDisclosure(storageKey);
  const [selectedView, setSelectedView] = useState<FileView | null>(null);
  const view = selectedView ?? (inputCount > 0 ? "inputs" : "outputs");
  const tabs = useRef<Partial<Record<FileView, HTMLButtonElement | null>>>({});
  const select = (next: FileView) => {
    setSelectedView(next);
    if (!open) toggle();
  };
  const views = [
    {
      name: "inputs",
      label: t("workspaceCardInputSources"),
      count: inputCount,
    },
    { name: "outputs", label: t("workspaceCardOutputs"), count: outputCount },
  ] as const;

  if (inputCount === 0 && outputCount === 0) return null;

  return (
    <section
      className={`ws-files-card ${embedded ? "ws-project-section" : "ws-card"}`}
      data-open={open}
    >
      <div className={embedded ? "ws-project-section-head" : "ws-card-head"}>
        <span className="ws-card-icon" aria-hidden>
          <FileCode2 size={13} />
        </span>
        <div
          className="ws-files-tabs"
          role="tablist"
          aria-label={t("workspaceCardFiles")}
        >
          {views.map(({ name, label, count }) => (
            <button
              key={name}
              ref={(element) => {
                tabs.current[name] = element;
              }}
              type="button"
              role="tab"
              id={`${id}-${name}-tab`}
              aria-selected={view === name}
              aria-controls={`${id}-${name}-panel`}
              tabIndex={view === name ? 0 : -1}
              onClick={() => select(name)}
              onKeyDown={(event) => {
                let next: FileView;
                if (event.key === "Home") next = "inputs";
                else if (event.key === "End") next = "outputs";
                else if (
                  event.key === "ArrowLeft" ||
                  event.key === "ArrowRight"
                )
                  next = name === "inputs" ? "outputs" : "inputs";
                else return;
                event.preventDefault();
                select(next);
                tabs.current[next]?.focus();
              }}
            >
              <span className="ws-files-tab-label">{label}</span>
              <span className="ws-card-count">{count}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ws-files-collapse"
          aria-label={t("workspaceCardFiles")}
          aria-expanded={open}
          aria-controls={`${id}-${view}-panel`}
          onClick={toggle}
        >
          <ChevronRight size={12} aria-hidden />
        </button>
      </div>
      {views.map(({ name, count }) => (
        <div
          key={name}
          id={`${id}-${name}-panel`}
          role="tabpanel"
          aria-labelledby={`${id}-${name}-tab`}
          hidden={!open || view !== name}
          tabIndex={0}
          className={embedded ? "ws-project-section-body" : "ws-card-body"}
        >
          {open &&
            view === name &&
            (count > 0 ? (
              name === "inputs" ? (
                inputs
              ) : (
                outputs
              )
            ) : (
              <div className="ws-empty">
                {t(
                  name === "inputs"
                    ? "workspaceNoInputSources"
                    : "workspaceNoOutputs",
                )}
              </div>
            ))}
        </div>
      ))}
    </section>
  );
}
