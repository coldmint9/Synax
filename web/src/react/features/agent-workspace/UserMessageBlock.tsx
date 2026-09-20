import { MediaParts } from "../media/MediaParts";
import type { RuntimeContentPart } from "../../../lib/api/runtimeMedia";
import { memo } from "react";

interface Props {
  content: string;
  contentParts?: RuntimeContentPart[];
}

export const UserMessageBlock = memo(function UserMessageBlock({
  content,
  contentParts,
}: Props) {
  return (
    <div className="flex justify-end">
      <div className="agent-conversation-copy max-w-[min(85%,42rem)] rounded-2xl border border-primary/15 bg-primary/[0.08] px-3.5 py-2.5 text-sm leading-relaxed text-foreground whitespace-pre-wrap shadow-sm">
        {content}
        <MediaParts parts={contentParts} />
      </div>
    </div>
  );
});
