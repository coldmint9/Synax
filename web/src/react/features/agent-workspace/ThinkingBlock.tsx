import { useLocale } from "../../../hooks/useLocale";
import { ThinkingTrace } from "./ThinkingTrace";
import { ThinkingBanner } from "./ThinkingBanner";
import {
  ACTIVITY_BODY_LIMIT,
  formatCharCount,
  latestActivityPreview,
  tailForDisplay,
  thinkingBannerPhrases,
} from "./activityText";

interface Props {
  content: string;
  isStreaming?: boolean;
  rememberKey?: string;
}

/**
 * Displays model supplied reasoning as it arrives.
 *
 * The text comes straight from the stream buffers: thought deltas are applied
 * at the rate the backend emits them, so revealing them a second time here
 * would only hold the transcript back from the real token rate.
 */
export function ThinkingBlock({ content, isStreaming, rememberKey }: Props) {
  const { t } = useLocale();
  const bannerPhrases = thinkingBannerPhrases(content);
  if (bannerPhrases)
    return <ThinkingBanner phrases={bannerPhrases} isStreaming={isStreaming} />;
  const { text, hidden } = tailForDisplay(content);
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
      title={latestActivityPreview(content, 400)}
      working={isStreaming}
      rememberKey={rememberKey}
      variant="reasoning"
    >
      <div className="bui-thinking-prose">{text}</div>
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
}
