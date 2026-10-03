import fs from "node:fs";
import { chromium, type LaunchOptions } from "playwright-core";

export const BROWSER_PATH_ENV = "SYNAX_BROWSER_PATH";
export const BROWSER_HEADLESS_ENV = "SYNAX_BROWSER_HEADLESS";

export interface BrowserLaunchTarget {
  source: string;
  options: LaunchOptions;
}

/** Headless by default; opt out per call or via SYNAX_BROWSER_HEADLESS=0. */
export function defaultHeadless(): boolean {
  const raw = process.env[BROWSER_HEADLESS_ENV]?.trim().toLowerCase();
  if (raw) return !["0", "false", "no", "off"].includes(raw);
  return true;
}

function systemBrowserCandidates(): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  if (process.platform === "win32") {
    return [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
  }
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  const names = [
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
  ];
  const found: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = `${dir}/${name}`;
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        found.push(candidate);
      } catch {
        // not here, keep scanning
      }
    }
  }
  return found;
}

/**
 * Ordered launch descriptors: an explicit env path first, then the
 * playwright-managed Chromium (only when actually downloaded), then system
 * Chrome/Edge installs. The session tries them in order until one launches.
 */
export function launchTargets(headless: boolean): BrowserLaunchTarget[] {
  const targets: BrowserLaunchTarget[] = [];
  const envPath = process.env[BROWSER_PATH_ENV]?.trim();
  if (envPath) {
    if (!fs.existsSync(envPath))
      throw new Error(
        `${BROWSER_PATH_ENV} points to a missing executable: ${envPath}`,
      );
    targets.push({
      source: `env ${BROWSER_PATH_ENV}`,
      options: { executablePath: envPath, headless },
    });
  }
  try {
    const bundled = chromium.executablePath();
    if (bundled && fs.existsSync(bundled))
      targets.push({
        source: "playwright-managed chromium",
        options: { headless },
      });
  } catch {
    // Registry unavailable (odd install); fall through to system browsers.
  }
  for (const channel of ["chrome", "msedge"] as const) {
    targets.push({ source: `system ${channel}`, options: { channel, headless } });
  }
  for (const executablePath of systemBrowserCandidates()) {
    targets.push({
      source: `system browser at ${executablePath}`,
      options: { executablePath, headless },
    });
  }
  return targets;
}

export interface LaunchedBrowser {
  browser: Awaited<ReturnType<typeof chromium.launch>>;
  source: string;
}

export function browserInstallError(attempts: string[]): Error {
  return new Error(
    [
      "No usable Chromium-based browser was found for the Playwright browser tools.",
      ...attempts.map((attempt) => `- ${attempt}`),
      "Fixes: run `npx playwright install chromium` (downloads a managed Chromium),",
      `or set ${BROWSER_PATH_ENV} to an existing Chrome/Chromium/Edge executable,`,
      "or install Google Chrome normally.",
    ].join("\n"),
  );
}

export async function launchWithFallback(
  headless: boolean,
): Promise<LaunchedBrowser> {
  const targets = launchTargets(headless);
  const attempts: string[] = [];
  for (const target of targets) {
    try {
      const browser = await chromium.launch(target.options);
      return { browser, source: target.source };
    } catch (error) {
      attempts.push(
        `${target.source}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw browserInstallError(attempts);
}
