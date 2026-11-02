import { useLocale } from "../../shared/hooks/useLocale";
import { MediaThumbnail } from "../media/MediaThumbnail";
import type { ToolCallView } from "./buildInterleavedTurns";
import { toolCallImageParts } from "./toolCallMedia";

interface Props {
  calls: readonly Pick<ToolCallView, "contentParts">[];
  className?: string;
}

/**
 * Images a call read or produced, painted directly in the transcript row.
 *
 * Every thumbnail opens the shared viewer, so a read screenshot or a generated
 * image can be inspected and zoomed without opening the call's text details.
 */
export function ToolCallMediaStrip({ calls, className = "" }: Props) {
  const { locale } = useLocale();
  const parts = toolCallImageParts(calls);
  if (!parts.length) return null;
  const label =
    locale === "zh"
      ? `相关图片（${parts.length} 张）`
      : `Related images (${parts.length})`;
  return (
    <div
      className={`bui-tool-media ${className}`.trim()}
      role="group"
      aria-label={label}
    >
      {parts.map((part) => (
        <MediaThumbnail key={part.assetId} assetId={part.assetId} />
      ))}
    </div>
  );
}
