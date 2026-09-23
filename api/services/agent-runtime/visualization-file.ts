import fs from "node:fs";
import path from "node:path";
import { MAX_VISUALIZATION_BYTES } from "./visualization-manifest.js";

function contains(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** One bounded read of one HTML fragment. No compiler, imports or general-purpose file API. */
export function readVisualizationFile(
  sourcePath: string,
  allowedRoots: string[],
): string {
  if (
    !/\.html?$/i.test(sourcePath) ||
    sourcePath.includes("\0") ||
    !allowedRoots.length
  )
    throw new Error("仅支持当前会话工作区内的 HTML 文件。");
  const candidate = path.resolve(allowedRoots[0], sourcePath);
  if (!allowedRoots.some((root) => contains(path.resolve(root), candidate)))
    throw new Error("预览文件不在当前会话授权的工作区内。");

  const roots = allowedRoots.flatMap((root) => {
    try {
      return [fs.realpathSync(root)];
    } catch {
      return [];
    }
  });
  const canonical = fs.realpathSync(candidate);
  if (!roots.some((root) => contains(root, canonical)))
    throw new Error("预览文件不在当前会话授权的工作区内。");
  if (!/\.html?$/i.test(canonical))
    throw new Error("预览目标必须是 HTML 文件。");
  const before = fs.statSync(canonical);
  if (!before.isFile()) throw new Error("预览路径必须是普通 HTML 文件。");
  if (before.size > MAX_VISUALIZATION_BYTES)
    throw new Error("预览内容过大，请简化后重新生成（上限 1 MB）。");
  const fd = fs.openSync(
    canonical,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw new Error("预览文件发生变化，请重新生成。");
    const bytes = Buffer.alloc(MAX_VISUALIZATION_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(
        fd,
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!read) break;
      length += read;
    }
    if (length > MAX_VISUALIZATION_BYTES)
      throw new Error("预览内容过大，请简化后重新生成（上限 1 MB）。");
    const after = fs.fstatSync(fd);
    const current = fs.statSync(candidate);
    if (
      after.size !== length ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      current.dev !== after.dev ||
      current.ino !== after.ino ||
      fs.realpathSync(candidate) !== canonical
    )
      throw new Error("预览文件发生变化，请重新生成。");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, length),
    );
  } finally {
    fs.closeSync(fd);
  }
}

/** Do not expose system paths or filesystem error details in message metadata. */
export function visualizationReadError(error: unknown): string {
  if (error instanceof Error && /^[\u4e00-\u9fff]/.test(error.message))
    return error.message;
  return "无法读取预览 HTML 文件，请确认文件仍存在于会话工作区内后重新生成。";
}
