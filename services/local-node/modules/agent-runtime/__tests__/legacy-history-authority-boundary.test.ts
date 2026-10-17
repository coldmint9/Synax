import fs from "node:fs";
import { describe, expect, it } from "vitest";

const httpRouteSource = fs.readFileSync(
  new URL("../../../transport/http/agent-runtime.ts", import.meta.url),
  "utf8",
);
const sessionRuntimeSource = fs.readFileSync(
  new URL("../session-runtime.ts", import.meta.url),
  "utf8",
);

const legacyModulePath =
  /(?:flat-history|simple-history|checkpoints\/(?:version-runtime|retention|operations|simple-fork|guards))/;

function staticImportSpecifiers(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => /^\s*import\b.*\bfrom\s+[\"']/.test(line))
    .map((line) => line.match(/\bfrom\s+[\"']([^\"']+)[\"']/)?.[1])
    .filter((specifier): specifier is string => Boolean(specifier));
}

describe("authoritative history dependency boundary", () => {
  it("does not statically import legacy readers or writers", () => {
    expect(staticImportSpecifiers(httpRouteSource).filter((specifier) => legacyModulePath.test(specifier))).toEqual([]);
    expect(staticImportSpecifiers(sessionRuntimeSource).filter((specifier) => legacyModulePath.test(specifier))).toEqual([]);
  });

  it("keeps legacy loading behind an explicit non-authoritative guard", () => {
    expect(httpRouteSource).toMatch(/loadLegacyHistoryModules/);
    expect(httpRouteSource).toMatch(/streamMode\(\) === "authoritative"/);
    expect(sessionRuntimeSource).toMatch(/loadLegacySessionHistoryModules/);
    expect(sessionRuntimeSource).toMatch(/SYNAX_RUNTIME_SIDECAR_STREAM === "authoritative"/);
  });
});
