import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import {
  computeOperations,
  OperationKind,
  type BlockMap,
  type Operation,
} from "./desktop-differential-engine.js";
import { fetchGithubResponse, fetchLimited } from "./ui-update-feed.js";
import {
  desktopUpdateArtifact,
  verifyDesktopArtifact,
  type DesktopRelease,
} from "./desktop-update-format.js";
import { verifyDesktopManifestSignature } from "./desktop-update-signing.js";
import type { DesktopTransfer } from "../updater/contract.js";

const unzip = promisify(gunzip);
const MAX_BLOCKS = 262_144;

// Fetch small intervening gaps rather than pay another GitHub/proxy round trip.
export function coalesceDifferentialRanges(
  operations: Operation[],
): Operation[] {
  const result: Operation[] = [];
  for (let i = 0; i < operations.length; i++) {
    const operation = { ...operations[i] };
    if (operation.kind === OperationKind.DOWNLOAD) {
      let gap = 0;
      for (let next = i + 1; next < operations.length; next++) {
        if (operations[next].kind === OperationKind.COPY) {
          gap += operations[next].end - operations[next].start;
          if (gap > 64 * 1024) break;
        } else {
          operation.end = operations[next].end;
          i = next;
          gap = 0;
        }
      }
    }
    result.push(operation);
  }
  return result;
}
export function validateDesktopBlockMap(
  value: unknown,
  size: number,
): BlockMap {
  const map = value as BlockMap;
  if (
    !map ||
    map.version !== "2" ||
    !Array.isArray(map.files) ||
    map.files.length !== 1
  )
    throw new Error("Unsupported desktop blockmap");
  const file = map.files[0];
  if (
    !file ||
    file.name !== "file" ||
    file.offset !== 0 ||
    !Array.isArray(file.sizes) ||
    !Array.isArray(file.checksums) ||
    !file.sizes.length ||
    file.sizes.length > MAX_BLOCKS ||
    file.sizes.length !== file.checksums.length
  )
    throw new Error("Invalid desktop blockmap structure");
  let total = 0;
  for (let i = 0; i < file.sizes.length; i++) {
    const length = file.sizes[i];
    if (
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > 1024 ** 2 ||
      typeof file.checksums[i] !== "string" ||
      !/^[A-Za-z0-9+/]{24}$/.test(file.checksums[i])
    )
      throw new Error("Invalid desktop blockmap chunk");
    total += length;
    if (total > size) throw new Error("Desktop blockmap exceeds artifact size");
  }
  if (total !== size)
    throw new Error("Desktop blockmap does not cover the artifact");
  return map;
}

async function loadBlockMap(
  release: DesktopRelease,
  directory: string,
): Promise<BlockMap> {
  const metadata = release.manifest.blockMap!;
  const file = path.join(directory, metadata.name);
  let bytes: Buffer;
  const cached = await verifyDesktopArtifact(file, metadata);
  if (cached) bytes = await fs.readFile(file);
  else
    bytes = await fetchLimited(
      new URL(metadata.name, release.url).href,
      metadata.size,
    );
  if (
    bytes.length !== metadata.size ||
    createHash("sha256").update(bytes).digest("hex") !== metadata.sha256
  )
    throw new Error("Desktop blockmap checksum mismatch");
  const map = validateDesktopBlockMap(
    JSON.parse(
      (await unzip(bytes, { maxOutputLength: 32 * 1024 ** 2 })).toString(
        "utf8",
      ),
    ),
    desktopUpdateArtifact(release.manifest).size,
  );
  if (!cached) {
    const temporary = `${file}.${randomUUID()}.part`;
    try {
      await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  return map;
}

export async function downloadDesktopDifferential(
  release: DesktopRelease,
  base: { release: DesktopRelease; file: string },
  temporary: string,
  onProgress?: (fraction: number) => void,
  onVerifying?: () => void,
  onTransfer?: (transfer: DesktopTransfer) => void,
): Promise<boolean> {
  if (
    !release.manifest.blockMap ||
    !base.release.manifest.blockMap ||
    !verifyDesktopManifestSignature(release.manifest) ||
    !verifyDesktopManifestSignature(base.release.manifest)
  )
    return false;
  const oldMap = await loadBlockMap(base.release, path.dirname(base.file));
  const newMap = await loadBlockMap(release, path.dirname(temporary));
  const artifact = desktopUpdateArtifact(release.manifest);
  const baseArtifact = desktopUpdateArtifact(base.release.manifest);
  const operations = coalesceDifferentialRanges(
    computeOperations(oldMap, newMap, {
      info() {},
      warn() {},
      error() {},
    }),
  );
  let outputOffset = 0;
  let downloadSize = 0;
  let requests = 0;
  for (const operation of operations) {
    const { kind, start, end } = operation;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start
    )
      throw new Error("Invalid differential operation");
    if (kind === OperationKind.DOWNLOAD) {
      if (start !== outputOffset || end > artifact.size)
        throw new Error("Invalid differential download range");
      downloadSize += end - start;
      requests++;
    } else if (kind !== OperationKind.COPY || end > baseArtifact.size)
      throw new Error("Invalid differential copy range");
    outputOffset += end - start;
  }
  if (outputOffset !== artifact.size)
    throw new Error("Incomplete differential plan");
  const overhead =
    release.manifest.blockMap.size + base.release.manifest.blockMap.size;
  if (requests > 256 || downloadSize + overhead >= artifact.size * 0.9)
    return false;
  let downloadedBytes = 0;
  const reusedBytes = artifact.size - downloadSize;
  const report = () => {
    onTransfer?.({
      mode: "differential",
      downloadSize,
      downloadedBytes,
      reusedBytes,
    });
    onProgress?.(downloadSize ? downloadedBytes / downloadSize : 0);
  };
  report();
  const signal = AbortSignal.timeout(30 * 60_000);
  const source = await fs.open(base.file, "r");
  try {
    const target = await fs.open(temporary, "wx", 0o600);
    try {
      const buffer = Buffer.alloc(1024 ** 2);
      for (const operation of operations) {
        signal.throwIfAborted();
        if (operation.kind === OperationKind.COPY) {
          let position = operation.start;
          while (position < operation.end) {
            signal.throwIfAborted();
            const { bytesRead } = await source.read(
              buffer,
              0,
              Math.min(buffer.length, operation.end - position),
              position,
            );
            if (!bytesRead) throw new Error("Differential base was truncated");
            await target.writeFile(buffer.subarray(0, bytesRead));
            position += bytesRead;
          }
          continue;
        }
        const response = await fetchGithubResponse(release.url, 60_000, {
          range: operation,
          signal,
        });
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get("content-range") ?? "",
        );
        const length = operation.end - operation.start;
        if (
          response.status !== 206 ||
          !range ||
          Number(range[1]) !== operation.start ||
          Number(range[2]) !== operation.end - 1 ||
          Number(range[3]) !== artifact.size ||
          (response.headers.has("content-length") &&
            Number(response.headers.get("content-length")) !== length) ||
          (response.headers.has("content-encoding") &&
            response.headers.get("content-encoding") !== "identity")
        ) {
          await response.body?.cancel();
          throw new Error(
            "Update server or proxy does not support exact byte ranges",
          );
        }
        const reader = response.body!.getReader();
        let received = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > length)
              throw new Error("Differential response exceeds range size");
            await target.writeFile(value);
            downloadedBytes += value.byteLength;
            report();
          }
          if (received !== length)
            throw new Error("Differential response is truncated");
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      onProgress?.(1);
      onVerifying?.();
      await target.sync();
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
  if (!(await verifyDesktopArtifact(temporary, artifact)))
    throw new Error("Reconstructed desktop package checksum mismatch");
  return true;
}
