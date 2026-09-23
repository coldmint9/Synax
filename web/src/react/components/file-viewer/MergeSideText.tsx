import { memo } from "react";
import { diffWordsWithSpace } from "diff";

/** Word comparison uses escaped React text and never mutates saved whitespace. */
export const MergeSideText = memo(function MergeSideText({
  target,
  source,
  side,
}: {
  target: string;
  source: string;
  side: "target" | "source";
}) {
  const text = side === "target" ? target : source;
  if (!text) return <pre>∅ 删除 / 无内容</pre>;
  if (target.length + source.length > 10000) return <pre>{text}</pre>;
  const parts = diffWordsWithSpace(target, source);
  return (
    <pre>
      {parts.map((part, index) => {
        if (
          (side === "target" && part.added) ||
          (side === "source" && part.removed)
        )
          return null;
        return (
          <span
            key={index}
            className={
              part.added || part.removed
                ? `shared-merge-word shared-merge-word--${side}`
                : undefined
            }
          >
            {part.value}
          </span>
        );
      })}
    </pre>
  );
});
