import { useRef } from "react";
import { Paperclip, X, RotateCcw } from "lucide-react";
import type { MediaDraft } from "./useMediaDraft";
import { MediaParts } from "./MediaParts";
export function MediaAttachButton({
  media,
  disabled,
}: {
  media: MediaDraft;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          media.add(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={disabled}
        aria-label="添加附件 / Attach files"
        title="图片、音频、视频、PDF或文件 / Attach files"
        className="agent-dock-composer-chip inline-flex size-8 items-center justify-center rounded-full disabled:opacity-50"
        onClick={() => ref.current?.click()}
      >
        <Paperclip size={15} />
      </button>
    </>
  );
}
export function MediaDraftPreview({ media }: { media: MediaDraft }) {
  return (
    <div aria-live="polite" className="max-h-64 w-full overflow-y-auto text-xs">
      {media.error && (
        <p role="alert" className="text-danger">
          {media.error}
        </p>
      )}
      {media.items
        .filter((item) => item.error)
        .map((item) => (
          <div
            key={item.id}
            className="my-1 flex items-center gap-2 rounded-lg bg-surface/60 px-2 py-1"
          >
            <span className="min-w-0 flex-1 truncate" title={item.file.name}>
              {item.file.name}
            </span>
            <span className="text-danger">{item.error}</span>
            <button
              type="button"
              aria-label={`重试 ${item.file.name}`}
              onClick={() => media.retry(item.id)}
            >
              <RotateCcw size={12} />
            </button>
            <button
              type="button"
              aria-label={`移除 ${item.file.name}`}
              onClick={() => media.remove(item.id)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      <MediaParts
        parts={media.parts}
        onRemove={(assetId) => {
          const item = media.items.find((entry) => entry.asset?.id === assetId);
          if (item) media.remove(item.id);
        }}
      />
    </div>
  );
}
