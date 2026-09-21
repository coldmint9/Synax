import path from "node:path";
import { openZip } from "./desktop-zip-engine.js";

/** Preflight every entry before ditto can create anything, including symlink ancestors. */
export async function validateMacUpdateArchive(file: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    openZip(
      file,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) {
          reject(error ?? new Error("Cannot open update archive"));
          return;
        }
        let ended = false;
        let size = 0;
        const paths = new Set<string>();
        const links = new Set<string>();
        const fail = (error: unknown) => {
          if (ended) return;
          ended = true;
          zip.close();
          reject(error);
        };
        zip.on("error", fail);
        zip.on("entry", (entry) => {
          void (async () => {
            const name = entry.fileName;
            const type = (entry.externalFileAttributes >>> 16) & 0o170000;
            if (
              !name.startsWith("Synax.app/") ||
              name.includes("\0") ||
              path.posix.normalize(name) !== name ||
              entry.isEncrypted() ||
              ![0, 8].includes(entry.compressionMethod) ||
              ![0, 0o040000, 0o100000, 0o120000].includes(type)
            )
              throw new Error("Unsafe desktop update archive entry");
            const key = name.replace(/\/$/, "").normalize("NFC").toLowerCase();
            if (paths.has(key) || paths.size >= 100_000)
              throw new Error("Duplicate or excessive update archive entries");
            paths.add(key);
            size += entry.uncompressedSize;
            if (
              !Number.isSafeInteger(entry.uncompressedSize) ||
              entry.uncompressedSize < 0 ||
              size > 4 * 1024 ** 3
            )
              throw new Error(
                "Desktop update archive exceeds extraction limit",
              );
            if (type === 0o120000) {
              if (entry.uncompressedSize > 4096 || key === "synax.app")
                throw new Error("Unsafe update archive symlink");
              const target = await new Promise<string>((resolve, reject) =>
                zip.openReadStream(entry, (error, stream) => {
                  if (error || !stream) {
                    reject(error ?? new Error("Cannot read update symlink"));
                    return;
                  }
                  const chunks: Buffer[] = [];
                  let count = 0;
                  stream.on("data", (chunk: Buffer) => {
                    count += chunk.length;
                    if (count > 4096)
                      stream.destroy(
                        new Error("Update symlink exceeds size limit"),
                      );
                    else chunks.push(chunk);
                  });
                  stream.on("error", reject);
                  stream.on("end", () =>
                    resolve(Buffer.concat(chunks).toString("utf8")),
                  );
                }),
              );
              const resolved = path.posix.resolve(
                "/",
                path.posix.dirname(name),
                target,
              );
              if (
                !target ||
                /[\0\\]/.test(target) ||
                target.startsWith("/") ||
                !resolved.startsWith("/Synax.app/")
              )
                throw new Error("Update symlink escapes application bundle");
              links.add(key);
            }
          })().then(() => {
            if (!ended) zip.readEntry();
          }, fail);
        });
        zip.on("end", () => {
          try {
            if (!paths.size) throw new Error("Empty desktop update archive");
            for (const name of paths) {
              const parts = name.split("/");
              for (let i = 1; i < parts.length; i++)
                if (links.has(parts.slice(0, i).join("/")))
                  throw new Error("Update archive writes through a symlink");
            }
            ended = true;
            resolve();
          } catch (error) {
            fail(error);
          }
        });
        zip.readEntry();
      },
    );
  });
}
