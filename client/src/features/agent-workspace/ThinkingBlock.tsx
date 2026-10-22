import { memo } from "react";
import { useLocale } from "../../shared/hooks/useLocale";
import { useShellStore } from "../../shared/state/shellStore";
import { ThinkingTrace } from "./ThinkingTrace";
import { useStreamingText } from "./useStreamingText";
import {
  ACTIVITY_BODY_LIMIT,
  activityPreview,
  formatCharCount,
  hasDisplayableReasoning,
  tailForDisplay,
  thinkingBannerPhrases,
} from "./activityText";

interface Props {
  content: string;
  isStreaming?: boolean;
  rememberKey?: string;
}

function ThinkingText({ text, streaming }: { text: string; streaming: boolean }) {
  const visible = useStreamingText(text, streaming, false);
  return <div className="bui-thinking-prose">{visible}</div>;
}

/** Collapsed previews update immediately; only the mounted body smooths bursts. */
export const ThinkingBlock = memo(function ThinkingBlock({ content, isStreaming, rememberKey }: Props) {
  const { t } = useLocale();
  const showThinking = useShellStore((state) => state.preferences.sessionShowThinking);
  if (!showThinking) return null;
  if (!hasDisplayableReasoning(content)) return null;
  const bannerPhrases = thinkingBannerPhrases(content);
  const displayContent = bannerPhrases ? bannerPhrases.join("\n") : content;
  const { text, hidden } = tailForDisplay(displayContent);
  return (
    <ThinkingTrace
      label={
        isStreaming ? t("sessionActivityThinking") : t("sessionActivityThought")
      }
      meta={
        isStreaming
          ? null
          : t("sessionActivityChars", {
              count: formatCharCount(content.length),
            })
      }
      title={activityPreview(displayContent, 400)}
      preview={activityPreview(displayContent, 180)}
      working={isStreaming}
      rememberKey={rememberKey}
      variant="reasoning"
    >
      <ThinkingText text={text} streaming={Boolean(isStreaming)} />
      {hidden > 0 && (
        <div className="bui-activity-footnote">
          {t("sessionActivityTruncated", {
            hidden: formatCharCount(hidden),
            shown: formatCharCount(ACTIVITY_BODY_LIMIT),
          })}
        </div>
      )}
    </ThinkingTrace>
  );
});
