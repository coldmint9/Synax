import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  stat,
} from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
let active = false;

/** Optional full Office layout renderer. Never invoke a shell or open the source UI. */
export async function renderOfficePdf(
  bytes: Uint8Array,
  kind: string,
): Promise<Uint8Array> {
  if (!/^(docx|xlsx|pptx)$/.test(kind)) throw new Error("不支持的 Office 格式");
  const candidates = [
    process.env.SYNAX_LIBREOFFICE_PATH,
    ...(process.platform === "darwin"
      ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
      : []),
    ...(process.platform === "win32"
      ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
          .filter((dir): dir is string => Boolean(dir))
          .map((dir) => path.join(dir, "LibreOffice/program/soffice.exe"))
      : []),
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .flatMap((dir) =>
        ["soffice", "libreoffice"].map((name) =>
          path.join(dir, process.platform === "win32" ? `${name}.exe` : name),
        ),
      ),
  ].filter((value): value is string => Boolean(value));
  let executable: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      executable = candidate;
      break;
    } catch {
      /* Try the next installation. */
    }
  }
  if (!executable) throw new Error("未安装 LibreOffice 文档渲染器");
  if (active) throw new Error("Office 文档渲染器忙碌，请稍后重试");
  active = true;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), "synax-office-"));
    const profile = path.join(directory, "profile");
    await mkdir(path.join(profile, "user"), { recursive: true });
    // Disable macros and external document updates in this disposable profile.
    await writeFile(
      path.join(profile, "user/registrymodifications.xcu"),
      `<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateDocMode" oor:op="fuse"><value>0</value></prop></item></oor:items>`,
    );
    const source = path.join(directory, `document.${kind}`);
    await writeFile(source, bytes);
    await run(
      executable,
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        "--headless",
        "--nologo",
        "--nodefault",
        "--norestore",
        "--nolockcheck",
        "--convert-to",
        "pdf",
        "--outdir",
        directory,
        source,
      ],
      { timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
    );
    const output = path.join(directory, "document.pdf");
    const size = (await stat(output)).size;
    if (size > 50 * 1024 * 1024 || !size)
      throw new Error("Office 渲染 PDF 超过尺寸限制或为空");
    return await readFile(output);
  } finally {
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } finally {
      active = false;
    }
  }
}
