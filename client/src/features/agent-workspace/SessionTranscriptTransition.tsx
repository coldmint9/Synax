import { useState } from "react";
import { Skeleton } from "@/shared/ui/ui/Display";
import { useLocale } from "../../shared/hooks/useLocale";
import { PixelLoader } from "./LoadingState";

/** Key by session so a cold load keeps its placeholder as partial pages arrive. */
export function SessionTranscriptTransition({
  preparing,
  hasCachedContent,
}: {
  preparing: boolean;
  hasCachedContent: boolean;
}) {
  const { locale } = useLocale();
  const [cached] = useState(hasCachedContent);
  return (
    <div
      className="session-transcript-loading absolute inset-0 z-20 overflow-hidden"
      data-cached={cached ? "true" : "false"}
      data-visible={preparing ? "true" : "false"}
      aria-hidden={!preparing}
      inert={!preparing}
    >
      {preparing && (cached ? (
        <div role="status" className="session-transcript-sync">
          <span className="session-transcript-sync-label">
            <PixelLoader variant="Thinking" />
            <span>
              {locale === "zh" ? "正在同步最新消息" : "Syncing latest messages"}
            </span>
          </span>
        </div>
      ) : (
        <div
          role="status"
          className="session-transcript-skeleton mx-auto w-full max-w-3xl space-y-6 px-[1.2rem] py-4"
        >
          <span className="sr-only">
            {locale === "zh" ? "正在加载对话" : "Loading conversation"}
          </span>
          <Skeleton className="ml-auto h-16 w-2/3 rounded-xl" />
          <Skeleton className="h-4 w-3/4 rounded-lg" />
          <Skeleton className="h-4 w-full rounded-lg" />
          <Skeleton className="h-4 w-1/2 rounded-lg" />
          <Skeleton className="mt-8 h-24 w-3/4 rounded-xl" />
        </div>
      ))}
    </div>
  );
}
