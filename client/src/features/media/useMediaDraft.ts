import { useCallback, useEffect, useRef, useId } from "react";
import {
  runtimeMedia,
  type RuntimeAsset,
  type RuntimeContentPart,
} from "../../adapters/transport/runtimeMedia";
import { createScopedDraftState } from "./scopedDraftState";

export const mediaDraftItems = createScopedDraftState<DraftMedia[]>();
const mediaDraftErrors = createScopedDraftState<string | null>();

/** The runtime keeps two asset writes in flight and answers 429 beyond that,
 * so multi-file drops queue here instead of racing into MEDIA_BUSY. */
const MAX_CONCURRENT_UPLOADS = 2;
const BUSY_RETRY_DELAYS_MS = [250, 750];

export interface DraftMedia {
  retained?: boolean;
  id: string;
  file: File;
  text?: string;
  asset?: RuntimeAsset;
  error?: string;
  /** Waiting for an upload slot rather than talking to the runtime. */
  queued?: boolean;
  uploading: boolean;
  controller: AbortController;
}

export interface UploadedDraft {
  /** Content parts for the attachments that are safely on the server. */
  parts: RuntimeContentPart[];
  /** Ids of the drafts that produced those parts, for a targeted clear. */
  itemIds: string[];
}

let activeUploads = 0;
const waitingUploads: Array<() => void> = [];
/**
 * Uploads in flight, keyed by `${draftKey}:${itemId}`, so a composer can wait
 * for exactly the attachments it owns even after its draft scope changes.
 */
const inflightUploads = new Map<string, Promise<void>>();

function acquireUploadSlot(start: () => void) {
  if (activeUploads < MAX_CONCURRENT_UPLOADS) {
    activeUploads += 1;
    start();
    return;
  }
  waitingUploads.push(start);
}

function releaseUploadSlot() {
  activeUploads = Math.max(0, activeUploads - 1);
  const next = waitingUploads.shift();
  if (!next) return;
  activeUploads += 1;
  next();
}

/** Test seam: drop queue bookkeeping a hanging upload may have left behind. */
export function resetMediaUploadQueue() {
  activeUploads = 0;
  waitingUploads.length = 0;
  inflightUploads.clear();
}

function toParts(items: DraftMedia[]): RuntimeContentPart[] {
  return items.flatMap((item): RuntimeContentPart[] => {
    if (item.text !== undefined)
      return [
        {
          type: "text",
          text: item.text,
          attachmentName: item.file.name,
        },
      ];
    if (!item.asset) return [];
    return [
      {
        type:
          item.asset.mediaType.startsWith("image/") &&
          item.asset.mediaType !== "image/svg+xml"
            ? "image"
            : item.asset.mediaType.startsWith("audio/")
              ? "audio"
              : item.asset.mediaType.startsWith("video/")
                ? "video"
                : "file",
        assetId: item.asset.id,
      },
    ];
  });
}

function isBusyUploadError(error: unknown) {
  return Boolean(
    error && typeof error === "object" && (error as { busy?: boolean }).busy,
  );
}

export async function prepareQueuedMedia(
  parts: RuntimeContentPart[] = [],
): Promise<DraftMedia[]> {
  const restored: Array<DraftMedia | null> = await Promise.all(
    parts
      .map(async (part) => {
        if (part.type === "text") {
          if (!part.attachmentName) return null;
          return {
            id: crypto.randomUUID(),
            file: new File([part.text], part.attachmentName, {
              type: "text/plain",
            }),
            text: part.text,
            uploading: false,
            controller: new AbortController(),
          } satisfies DraftMedia;
        }
        const { asset } = await runtimeMedia.metadata(part.assetId);
        return {
          id: crypto.randomUUID(),
          file: new File([], asset.filename, { type: asset.mediaType }),
          asset,
          retained: true,
          uploading: false,
          controller: new AbortController(),
        } satisfies DraftMedia;
      }),
  );
  return restored.filter((item) => item !== null);
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
      .map(async (part) => {
        if (part.type === "text") {
          if (!part.attachmentName) return null;
          return {
            id: crypto.randomUUID(),
            file: new File([part.text], part.attachmentName, {
              type: "text/plain",
            }),
            text: part.text,
            uploading: false,
            controller: new AbortController(),
          } satisfies DraftMedia;
        }
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
    entry.status === "fulfilled" && entry.value !== null ? [entry.value] : [],
  );
}
export function useMediaDraft(
  projectId: string,
  onPartsChange?: (parts: RuntimeContentPart[]) => void,
  scope?: string,
) {
  const instance = useId();
  const key = scope ?? `media-instance:${instance}:${projectId}`;
  const uploadPrefix = `${key}:`;
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
  /**
   * Attachments enter the draft immediately and upload on a shared queue, so
   * adding files never waits for another request and never blocks the input.
   */
  const upload = useCallback(
    (item: DraftMedia) => {
      const slotKey = `${uploadPrefix}${item.id}`;
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      inflightUploads.set(slotKey, settled);
      let finished = false;
      let slotHeld = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        item.controller.signal.removeEventListener("abort", finish);
        if (inflightUploads.get(slotKey) === settled)
          inflightUploads.delete(slotKey);
        if (slotHeld) {
          slotHeld = false;
          releaseUploadSlot();
        }
        settle();
      };
      // An aborted upload must free its slot even when the request never settles.
      item.controller.signal.addEventListener("abort", finish, { once: true });
      acquireUploadSlot(() => {
        if (finished) {
          releaseUploadSlot();
          return;
        }
        slotHeld = true;
        setItems((all) =>
          all.map((x) => (x.id === item.id && x.queued ? { ...x, queued: false } : x)),
        );
        void (async () => {
          try {
            for (let attempt = 0; ; attempt += 1) {
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
                    x.id === item.id
                      ? { ...x, asset, uploading: false, queued: false }
                      : x,
                  ),
                );
                return;
              } catch (e) {
                if (item.controller.signal.aborted) return;
                const delay = BUSY_RETRY_DELAYS_MS[attempt];
                if (delay !== undefined && isBusyUploadError(e)) {
                  await new Promise((resolve) => setTimeout(resolve, delay));
                  continue;
                }
                setItems((all) =>
                  all.map((x) =>
                    x.id === item.id
                      ? {
                          ...x,
                          uploading: false,
                          queued: false,
                          error: e instanceof Error ? e.message : String(e),
                        }
                      : x,
                  ),
                );
                return;
              }
            }
          } finally {
            finish();
          }
        })();
      });
    },
    [uploadPrefix, projectId, setItems],
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
        queued: true,
        controller: new AbortController(),
      }));
      setItems([...readItems(), ...added]);
      for (const item of added) upload(item);
    },
    [upload, readItems, setItems, setError],
  );
  const addText = useCallback(
    (text: string, filename = `粘贴文本 · ${new Date().toISOString().replace(/[:.]/g, "-")}.txt`) => {
      if (!text) return;
      const item: DraftMedia = {
        id: crypto.randomUUID(),
        file: new File([text], filename, { type: "text/plain" }),
        text,
        uploading: false,
        controller: new AbortController(),
      };
      const all = [...readItems(), item];
      if (all.length > 10 || all.reduce((sum, entry) => sum + entry.file.size, 0) > 100 * 1024 * 1024) {
        setError(
          "最多 10 个文件，合计 100 MiB / Attachment limit exceeded",
        );
        return;
      }
      setError(null);
      setItems(all);
    },
    [readItems, setError, setItems],
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
        queued: true,
      };
      setItems((all) => all.map((x) => (x.id === id ? item : x)));
      upload(item);
    },
    [upload, readItems, setItems, setError],
  );
  /**
   * Only the given drafts are dropped so attachments added while a submit is
   * waiting for its uploads survive the send.
   */
  const clear = useCallback(
    (ids?: string[]) => {
      const dropped = new Set(ids);
      for (const item of readItems())
        if (!ids || dropped.has(item.id)) item.controller.abort();
      setItems((all) => (ids ? all.filter((x) => !dropped.has(x.id)) : []));
      setError(null);
    },
    [readItems, setItems, setError],
  );
  const restore = useCallback(
    (restored: DraftMedia[]) => {
      for (const item of readItems()) item.controller.abort();
      setItems(restored);
      setError(null);
    },
    [readItems, setItems, setError],
  );
  /**
   * Resolves once every attachment of this draft is on the server. Sending
   * awaits this instead of disabling the send button, so typing and adding
   * files stay unblocked while uploads run.
   */
  const waitForUploads = useCallback(async (): Promise<UploadedDraft> => {
    for (;;) {
      const pending = [...inflightUploads.entries()]
        .filter(([slot]) => slot.startsWith(uploadPrefix))
        .map(([, promise]) => promise);
      if (!pending.length) break;
      await Promise.all(pending);
    }
    const snapshot = readItems();
    const failed = snapshot.find((item) => item.error);
    if (failed)
      throw new Error(
        `附件上传失败，请重试或移除 / Attachment upload failed: ${failed.error}`,
      );
    const uploaded = snapshot.filter((item) => item.asset || item.text);
    return {
      parts: toParts(uploaded),
      itemIds: uploaded.map((item) => item.id),
    };
  }, [uploadPrefix, readItems]);
  /** Synchronous check so an ordinary send keeps its immediate submit path. */
  const hasPendingUploads = useCallback(() => {
    for (const slot of inflightUploads.keys())
      if (slot.startsWith(uploadPrefix)) return true;
    return false;
  }, [uploadPrefix]);
  const parts: RuntimeContentPart[] = toParts(items);
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
      items.every(
        (i) =>
          (i.text !== undefined || Boolean(i.asset)) &&
          !i.uploading &&
          !i.error,
      ),
    /** A failed upload or a rejected selection; sending must not start. */
    blocked: Boolean(error) || items.some((i) => Boolean(i.error)),
    /** True while any attachment still waits for the runtime. */
    uploading: items.some((i) => i.uploading),
    add,
    addText,
    remove,
    retry,
    clear,
    restore,
    hasPendingUploads,
    waitForUploads,
  };
}
export type MediaDraft = ReturnType<typeof useMediaDraft>;
