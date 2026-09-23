import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  src?: string;
  alt?: string;
  title?: string;
}

export function MarkdownImage({ src, alt = "", title }: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!src) return null;

  return (
    <>
      <button
        type="button"
        className="markdown-image-trigger"
        aria-label={alt ? `放大图片：${alt}` : "放大图片"}
        title={title ?? alt}
        onClick={() => setOpen(true)}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="markdown-image"
          onError={(event) => {
            event.currentTarget
              .closest(".markdown-image-trigger")
              ?.classList.add("markdown-image-trigger--error");
          }}
        />
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="markdown-image-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={alt || "图片预览"}
            onClick={() => setOpen(false)}
          >
            <div className="markdown-image-lightbox-frame">
              <img
                src={src}
                alt={alt}
                className="markdown-image-lightbox-image"
                onClick={(event) => event.stopPropagation()}
              />
              <button
                type="button"
                className="markdown-image-lightbox-close"
                aria-label="关闭图片预览"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
