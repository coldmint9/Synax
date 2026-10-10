import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { useState } from "react";

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
      <Dialog open={open} onClose={() => setOpen(false)} className="relative z-[1000]">
        <DialogBackdrop className="fixed inset-0 bg-black/80" />
        <div className="markdown-image-lightbox">
          <DialogPanel className="markdown-image-lightbox-frame">
            <DialogTitle className="sr-only">{alt || "图片预览"}</DialogTitle>
            <img
              src={src}
              alt={alt}
              className="markdown-image-lightbox-image"
            />
            <button
              type="button"
              className="markdown-image-lightbox-close"
              aria-label="关闭图片预览"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </DialogPanel>
        </div>
      </Dialog>
    </>
  );
}
