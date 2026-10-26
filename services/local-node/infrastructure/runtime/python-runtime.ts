import fs from "node:fs";
import path from "node:path";

export function pythonRuntimeBinary(root: string, platform = process.platform, arch: string = process.arch): string {
  return path.join(root, `${platform}-${arch}`, ...(platform === "win32" ? ["python.exe"] : ["bin", "python3"]));
}

/** Resolve without starting a process on the API event loop. Packaged builds never use host Python. */
export function resolvePythonRuntime(options: {
  env?: NodeJS.ProcessEnv; resourcesPath?: string; platform?: NodeJS.Platform; arch?: string;
} = {}): string | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const resources = options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [env.SYNAX_PYTHON_RUNTIME,
    resources ? pythonRuntimeBinary(path.join(resources, "python-runtime"), platform, options.arch) : undefined];
  if (env.NODE_ENV !== "production" && !resources)
    for (const dir of (env.PATH ?? "").split(platform === "win32" ? ";" : path.delimiter))
      if (dir && path.isAbsolute(dir)) candidates.push(path.join(dir, platform === "win32" ? "python3.exe" : "python3"));
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, platform === "win32" ? fs.constants.R_OK : fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch { /* Try the next explicitly permitted runtime. */ }
  }
  return undefined;
}
