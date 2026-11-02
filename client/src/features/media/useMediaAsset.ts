import { useCallback, useEffect, useState } from "react";
import { runtimeMedia, type RuntimeAsset } from "../../adapters/transport/runtimeMedia";

export interface MediaAssetState {
  asset?: RuntimeAsset;
  /** Object URL for the asset bytes; revoked when the owner unmounts. */
  url?: string;
  /** Decoded text for plain-text attachments. */
  textContent?: string;
  error: string;
}

/**
 * Loads one runtime asset for display.
 *
 * Transcript rows, thumbnails and attachment cards all render the same asset
 * reference, so the metadata/blob request and its object-URL lifetime live in
 * one place instead of every media surface repeating the fetch.
 */
export function useMediaAsset(id: string) {
  const [state, setState] = useState<MediaAssetState>({ error: "" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setState({ error: "" });
    void runtimeMedia
      .metadata(id)
      .then(async ({ asset }) => {
        if (controller.signal.aborted) return;
        setState({ asset, error: "" });
        const blob = await runtimeMedia.blob(id, controller.signal);
        if (controller.signal.aborted) return;
        const textContent =
          asset.mediaType === "text/plain" ? await blob.text() : undefined;
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ asset, url: objectUrl, textContent, error: "" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // Keep the metadata already resolved: a failed body still names the
        // asset it belongs to, so the error surface can say which file broke.
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { ...state, retry };
}
