import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";
import { ThinkingGlyph } from "./ThinkingTrace";

interface Props {
  phrases: string[];
  isStreaming?: boolean;
}

export function ThinkingBanner({ phrases, isStreaming }: Props) {
  const { t } = useLocale();
  // Untouched carousels follow the newest headline; an explicit step away is
  // the reader's business until the next headline arrives.
  const [active, setActive] = useState<number | null>(null);
  const [seen, setSeen] = useState(phrases.length);

  useEffect(() => {
    if (phrases.length <= seen) return;
    setSeen(phrases.length);
    setActive(null);
  }, [phrases.length, seen]);

  const index = Math.min(active ?? phrases.length - 1, phrases.length - 1);
  const phrase = phrases[index];
  const hasMultiple = phrases.length > 1;

  return (
    <div className="bui-thinking-banner" data-live={isStreaming || undefined}>
      <span className="bui-thinking-banner-symbol" aria-hidden="true">
        <ThinkingGlyph />
      </span>
      <span className="bui-thinking-banner-label">
        {isStreaming
          ? t("sessionActivityThinking")
          : t("sessionActivityThought")}
      </span>
      <span className="bui-thinking-banner-chunk">
        <span role="status" className="bui-thinking-banner-text" title={phrase}>
          {phrase}
        </span>
      </span>
      {hasMultiple && (
        <span className="bui-thinking-banner-controls">
          <button
            type="button"
            className="bui-thinking-banner-nav"
            aria-label={t("sessionThinkingPrevious")}
            disabled={index === 0}
            onClick={() => setActive(Math.max(0, index - 1))}
          >
            <ChevronLeft size={13} aria-hidden="true" />
          </button>
          <span
            className="bui-thinking-banner-position"
            aria-label={t("sessionThinkingPosition", {
              current: index + 1,
              total: phrases.length,
            })}
          >
            {index + 1}/{phrases.length}
          </span>
          <button
            type="button"
            className="bui-thinking-banner-nav"
            aria-label={t("sessionThinkingNext")}
            disabled={index === phrases.length - 1}
            onClick={() => setActive(Math.min(phrases.length - 1, index + 1))}
          >
            <ChevronRight size={13} aria-hidden="true" />
          </button>
        </span>
      )}
    </div>
  );
}
