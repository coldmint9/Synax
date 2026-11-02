import { useState } from "react";
import { ImageOff, LoaderCircle } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import { ImageViewer } from "../../shared/ui/image-viewer/ImageViewer";
import { useMediaAsset } from "./useMediaAsset";
import "./mediaThumbnail.css";

interface Props {
  assetId: string;
  /** Used until the asset metadata names the file. */
  alt?: string;
}

/**
 * A runtime image as a clickable thumbnail.
 *
 * The bytes stay behind an object URL owned by this component, so the
 * thumbnail can sit inside a virtualized transcript row without leaking
 * previews after unmount.
 */
export function MediaThumbnail({ assetId, alt }: Props) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const { asset, url, error, retry } = useMediaAsset(assetId);
  const [open, setOpen] = useState(false);
  const label = asset?.filename ?? alt ?? (zh ? "图片" : "Image");

  if (error) {
    return (
      <button
        type="button"
        className="bui-media-thumb bui-media-thumb--error"
        title={zh ? `图片加载失败：${label}（点击重试）` : `Image failed to load: ${label} (click to retry)`}
        aria-label={zh ? `图片加载失败：${label}` : `Image failed to load: ${label}`}
        onClick={retry}
      >
        <ImageOff size={16} aria-hidden="true" />
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className="bui-media-thumb"
        title={label}
        aria-label={zh ? `查看图片：${label}` : `View image: ${label}`}
        disabled={!url}
        onClick={() => setOpen(true)}
      >
        {url ? (
          <img src={url} alt={label} loading="lazy" decoding="async" />
        ) : (
          <LoaderCircle size={15} className="bui-media-thumb-spinner" aria-hidden="true" />
        )}
      </button>
      {open && url && (
        <ImageViewer
          src={url}
          alt={label}
          downloadName={asset?.filename}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
