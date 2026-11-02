import { useState } from "react";
import { ImageViewer } from "../image-viewer/ImageViewer";

interface Props {
  src?: string;
  alt?: string;
  title?: string;
}

export function MarkdownImage({ src, alt = "", title }: Props) {
  const [open, setOpen] = useState(false);
  const [failedSrc, setFailedSrc] = useState<string>();
  const failed = failedSrc === src;

  if (!src) return null;

  return (
    <>
      <button
        type="button"
        className={`markdown-image-trigger${failed ? " markdown-image-trigger--error" : ""}`}
        aria-label={failed ? `图片加载失败${alt ? `：${alt}` : ""}` : alt ? `放大图片：${alt}` : "放大图片"}
        title={title ?? (alt || "点击放大图片")}
        disabled={failed}
        onClick={() => setOpen(true)}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="markdown-image"
          onLoad={() => setFailedSrc(undefined)}
          onError={() => setFailedSrc(src)}
        />
        {failed && <span className="markdown-image-error" role="status">图片加载失败{alt ? `：${alt}` : ""}</span>}
      </button>
      {open && (
        <ImageViewer
          src={src}
          alt={alt}
          title={title}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
