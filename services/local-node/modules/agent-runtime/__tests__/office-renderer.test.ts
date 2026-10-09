import { afterEach, describe, expect, it, vi } from "vitest";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderOfficePdf } from "../file-input/office-renderer.js";
import { makePdf } from "./file-input-fixtures.js";
const processMock = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: processMock.execute }));
afterEach(() => {
  vi.unstubAllEnvs();
  processMock.execute.mockReset();
});
describe("Office renderer lifecycle", () => {
  it.each(["docx", "xlsx", "pptx"])(
    "converts %s using an isolated profile and cleans temporary files",
    async (kind) => {
      vi.stubEnv("SYNAX_LIBREOFFICE_PATH", process.execPath);
      let temporary = "";
      processMock.execute.mockImplementation(
        (executable, args, options, callback) => {
          void (async () => {
            expect(executable).toBe(process.execPath);
            expect(options.timeout).toBe(60_000);
            expect(options.killSignal).toBe("SIGKILL");
            expect(args).toContain("--headless");
            expect(args).toContain("--convert-to");
            temporary = args[args.indexOf("--outdir") + 1];
            expect(
              await readFile(path.join(temporary, `document.${kind}`)),
            ).toEqual(Buffer.from("fixture"));
            const profile = fileURLToPath(
              args[0].slice("-env:UserInstallation=".length),
            );
            expect(profile).toBe(path.join(temporary, "profile"));
            expect(
              await readFile(
                path.join(profile, "user/registrymodifications.xcu"),
                "utf8",
              ),
            ).toContain("MacroSecurityLevel");
            await writeFile(path.join(temporary, "document.pdf"), makePdf());
            callback(null, "converted", "");
          })().catch(callback);
        },
      );
      expect(await renderOfficePdf(Buffer.from("fixture"), kind)).toEqual(
        makePdf(),
      );
      await expect(access(temporary)).rejects.toThrow();
    },
  );
  it("cleans after a failed process and releases the rendering slot", async () => {
    vi.stubEnv("SYNAX_LIBREOFFICE_PATH", process.execPath);
    let temporary = "";
    processMock.execute.mockImplementation(
      (_executable, args, _options, callback) => {
        temporary = args[args.indexOf("--outdir") + 1];
        callback(new Error("conversion failed"));
      },
    );
    await expect(
      renderOfficePdf(Buffer.from("fixture"), "docx"),
    ).rejects.toThrow("conversion failed");
    await expect(access(temporary)).rejects.toThrow();
    await expect(
      renderOfficePdf(Buffer.from("fixture"), "xlsx"),
    ).rejects.toThrow("conversion failed");
    expect(processMock.execute).toHaveBeenCalledTimes(2);
  });
});
