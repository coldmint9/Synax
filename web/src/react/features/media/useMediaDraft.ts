import { useCallback, useEffect, useRef, useId } from "react";
import {
  runtimeMedia,
  type RuntimeAsset,
  type RuntimeContentPart,
} from "../../../lib/api/runtimeMedia";
import { createScopedDraftState } from "./scopedDraftState";

export const mediaDraftItems = createScopedDraftState<DraftMedia[]>();
const mediaDraftErrors = createScopedDraftState<string | null>();

export interface DraftMedia {
  retained?: boolean;
  id: string;
  file: File;
  asset?: RuntimeAsset;
  error?: string;
  uploading: boolean;
  controller: AbortController;
}

export async function prepareQueuedMedia(
  parts: RuntimeContentPart[] = [],
): Promise<DraftMedia[]> {
  return Promise.all(
    parts
      .filter((part) => part.type !== "text")
      .map(async (part) => {
        const { asset } = await runtimeMedia.metadata(part.assetId);
        return {
          id: crypto.randomUUID(),
          file: new File([], asset.filename, { type: asset.mediaType }),
          asset,
          retained: true,
          uploading: false,
          controller: new AbortController(),
        };
      }),
  );
}

/**
 * Rebuild draft attachments from cached content parts. Assets that no longer
 * resolve are skipped so the composer can persist only the survivors. Items
 * stay non-retained: the draft cache is their sole owner, so removing one
 * later also deletes its server asset.
 */
export async function restoreDraftMedia(
  parts: RuntimeContentPart[] = [],
): Promise<DraftMedia[]> {
  const settled = await Promise.allSettled(
    parts
      .filter((part) => part.type !== "text")
      .map(async (part) => {
        const { asset } = await runtimeMedia.metadata(part.assetId);
        return {
          id: crypto.randomUUID(),
          file: new File([], asset.filename, { type: asset.mediaType }),
          asset,
          uploading: false,
          controller: new AbortController(),
        } satisfies DraftMedia;
      }),
  );
  return settled.flatMap((entry) =>
    entry.status === "fulfilled" ? [entry.value] : [],
  );
}
export function useMediaDraft(
  projectId: string,
  onPartsChange?: (parts: RuntimeContentPart[]) => void,
  scope?: string,
) {
  const instance = useId();
  const key = scope ?? `media-instance:${instance}:${projectId}`;
  const [items, setItems, readItems] = mediaDraftItems.useDraft(key, () => []);
  const [error, setError] = mediaDraftErrors.useDraft(key, () => null);
  useEffect(() => {
    if (scope) return; // Session drafts own uploads even while not visible.
    return () => {
      for (const item of readItems()) item.controller.abort();
      setItems([]);
      setError(null);
    };
  }, [scope, readItems, setItems, setError]);
  const upload = useCallback(
    async (item: DraftMedia) => {
      try {
        const asset = await runtimeMedia.upload(
          projectId,
          item.file,
          item.controller.signal,
        );
        if (item.controller.signal.aborted) {
          void runtimeMedia.remove(asset.id).catch(() => {});
          return;
        }
        setItems((all) =>
          all.map((x) =>
            x.id === item.id ? { ...x, asset, uploading: false } : x,
          ),
        );
      } catch (e) {
        if (item.controller.signal.aborted) return;
        setItems((all) =>
          all.map((x) =>
            x.id === item.id
              ? {
                  ...x,
                  uploading: false,
                  error: e instanceof Error ? e.message : String(e),
                }
              : x,
          ),
        );
      }
    },
    [projectId, setItems],
  );
  const add = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const all = [
        ...readItems().map((i) => ({ size: i.asset?.size ?? i.file.size })),
        ...files,
      ];
      if (
        all.length > 10 ||
        all.some((f) => !f.size || f.size > 50 * 1024 * 1024) ||
        all.reduce((s, f) => s + f.size, 0) > 100 * 1024 * 1024
      ) {
        setError(
          "最多 10 个文件，单文件 50 MiB，合计 100 MiB / Attachment limit exceeded",
        );
        return;
      }
      setError(null);
      const added = files.map((file) => ({
        id: crypto.randomUUID(),
        file,
        uploading: true,
        controller: new AbortController(),
      }));
      setItems([...readItems(), ...added]);
      for (const item of added) void upload(item);
    },
    [upload, readItems, setItems, setError],
  );
  const remove = useCallback(
    (id: string) => {
      const item = readItems().find((x) => x.id === id);
      item?.controller.abort();
      if (item?.asset && !item.retained)
        void runtimeMedia.remove(item.asset.id).catch(() => {});
      setItems((all) => all.filter((x) => x.id !== id));
      setError(null);
    },
    [readItems, setItems, setError],
  );
  const retry = useCallback(
    (id: string) => {
      const old = readItems().find((x) => x.id === id);
      if (!old) return;
      const item = {
        ...old,
        controller: new AbortController(),
        error: undefined,
        uploading: true,
      };
      setItems((all) => all.map((x) => (x.id === id ? item : x)));
      void upload(item);
    },
    [upload, readItems, setItems, setError],
  );
  const clear = useCallback(() => {
    for (const item of readItems()) item.controller.abort();
    setItems([]);
    setError(null);
  }, [readItems, setItems, setError]);
  const restore = useCallback(
    (restored: DraftMedia[]) => {
      for (const item of readItems()) item.controller.abort();
      setItems(restored);
      setError(null);
    },
    [readItems, setItems, setError],
  );
  const parts: RuntimeContentPart[] = items.flatMap((item) =>
    item.asset
      ? [
          {
            type: item.asset.mediaType.startsWith("image/")
              ? "image"
              : item.asset.mediaType.startsWith("audio/")
                ? "audio"
                : item.asset.mediaType.startsWith("video/")
                  ? "video"
                  : "file",
            assetId: item.asset.id,
          },
        ]
      : [],
  );
  const partKey = JSON.stringify(parts);
  const changeRef = useRef(onPartsChange);
  changeRef.current = onPartsChange;
  useEffect(() => {
    changeRef.current?.(JSON.parse(partKey));
  }, [partKey]);
  return {
    items,
    parts,
    error,
    ready:
      !error &&
      items.every((i) => Boolean(i.asset) && !i.uploading && !i.error),
    add,
    remove,
    retry,
    clear,
    restore,
  };
}
export type MediaDraft = ReturnType<typeof useMediaDraft>;
