import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  createAsset,
  deleteUnboundAsset,
  getAsset,
  readAsset,
} from "../services/agent-runtime/media-assets.js";
import { MAX_FILE_BYTES } from "../services/agent-runtime/content-parts.js";
import { toHttpError } from "../services/agent-runtime/runtime-errors.js";
export const runtimeAssetRoutes = new Hono();
runtimeAssetRoutes.onError((error, c) => {
  const mapped = toHttpError(error);
  return c.json(mapped.body, mapped.status as 400);
});
runtimeAssetRoutes.post(
  "/",
  bodyLimit({
    maxSize: MAX_FILE_BYTES + 1024 * 1024,
    onError: (c) =>
      c.json({ error: "File exceeds 50 MiB.", code: "MEDIA_TOO_LARGE" }, 413),
  }),
  async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    const projectId = form.get("projectId");
    if (!(file instanceof File) || typeof projectId !== "string")
      return c.json({ error: "file and projectId are required." }, 400);
    return c.json(
      {
        asset: await createAsset(
          projectId,
          file.name,
          Buffer.from(await file.arrayBuffer()),
          file.type,
        ),
      },
      201,
    );
  },
);
runtimeAssetRoutes.get("/:id", (c) =>
  c.json({ asset: getAsset(c.req.param("id")) }),
);
runtimeAssetRoutes.delete("/:id", async (c) => {
  await deleteUnboundAsset(c.req.param("id"));
  return c.json({ deleted: true });
});
runtimeAssetRoutes.get("/:id/content", async (c) => {
  const asset = getAsset(c.req.param("id"));
  const bytes = await readAsset(asset.id);
  c.header("Content-Type", asset.mediaType);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Security-Policy", "default-src 'none'; sandbox");
  c.header(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
  );
  c.header("Accept-Ranges", "bytes");
  const range = c.req.header("Range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = 0,
      end = bytes.length - 1;
    if (!m || (!m[1] && !m[2]))
      return c.body(null, 416, { "Content-Range": `bytes */${bytes.length}` });
    if (!m[1]) start = Math.max(0, bytes.length - Number(m[2]));
    else {
      start = Number(m[1]);
      if (m[2]) end = Math.min(end, Number(m[2]));
    }
    if (start > end || start >= bytes.length)
      return c.body(null, 416, { "Content-Range": `bytes */${bytes.length}` });
    c.header("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
    c.header("Content-Length", String(end - start + 1));
    return c.body(new Uint8Array(bytes.subarray(start, end + 1)), 206);
  }
  c.header("Content-Length", String(bytes.length));
  return c.body(new Uint8Array(bytes));
});
