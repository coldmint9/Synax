import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = {
  CONFIG_ENCRYPTION_KEY: process.env.CONFIG_ENCRYPTION_KEY,
  DATA_ROOT: process.env.DATA_ROOT,
};
let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Synax-deepseek-input-"));
  process.env.DATA_ROOT = tempDir;
  process.env.CONFIG_ENCRYPTION_KEY = "unit-test-secret";
  vi.resetModules();
});

afterEach(async () => {
  const dbModule = await import("../../../db/index.js");
  dbModule.closeDb();
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  process.env.DATA_ROOT = originalEnv.DATA_ROOT;
  process.env.CONFIG_ENCRYPTION_KEY = originalEnv.CONFIG_ENCRYPTION_KEY;
});

const EMPTY_CATALOG = {
  providers: [],
  fetchedAt: new Date().toISOString(),
  source: "snapshot" as const,
};

/** The DeepSeek preset the settings UI ships (`custom-api:deepseek`). */
async function setupDeepSeekProvider(
  apiFormat: "openai" | "openai-responses" = "openai",
): Promise<void> {
  const { getGlobalConfig, updateGlobalConfig } = await import(
    "../../../lib/config/config-store.js"
  );
  const current = getGlobalConfig();
  updateGlobalConfig(
    {
      providers: [
        ...current.providers,
        {
          id: "custom-api:deepseek",
          label: "DeepSeek",
          status: "live",
          kind: "api",
          caps: { canFollowUp: true, canCancel: true },
          models: [
            {
              id: "deepseek-chat",
              label: "deepseek-chat",
              isDefault: true,
              inputModalities: ["text", "image"],
            },
            {
              id: "deepseek-flash",
              label: "deepseek-flash",
              inputModalities: ["text", "image"],
            },
            { id: "deepseek-reasoner", label: "deepseek-reasoner" },
          ],
        },
      ],
      providerConnections: {
        "custom-api:deepseek": {
          providerId: "custom-api:deepseek",
          baseUrl: "https://api.deepseek.com",
          apiKey: "sk-test",
          extra: { kind: "api", apiFormat },
        },
      },
    },
    "tester",
  );
}

async function resolveCapabilities(modelOverride: string) {
  const { getGlobalConfigForRuntime } = await import(
    "../../../lib/config/config-store.js"
  );
  const { resolveLlmSelection } = await import("../../llm-runtime/resolver.js");
  const { nativeInputCapabilities } = await import("../media-capabilities.js");
  const selection = resolveLlmSelection({
    catalog: EMPTY_CATALOG,
    globalConfig: getGlobalConfigForRuntime(),
    projectConfig: null,
    purpose: "agent",
    modelOverride,
  });
  return { selection, capabilities: nativeInputCapabilities(selection) };
}

describe("DeepSeek input capabilities", () => {
  it("keeps the declared image modality reachable for DeepSeek models", async () => {
    await setupDeepSeekProvider();

    const { selection, capabilities } = await resolveCapabilities(
      "custom-api:deepseek/deepseek-chat",
    );

    // The official DeepSeek base URL resolves to the native DeepSeek adapter.
    expect(selection.provider.npm).toBe("@ai-sdk/deepseek");
    // Declaring `image` must survive to the capability check instead of being
    // flattened into an unverified text-only capability.
    expect(capabilities.verified).toBe(true);
    expect(capabilities.modalities).toContain("image");
    expect(capabilities.mediaTypes).toContain("image/png");
  });

  it("still flags models without a declaration as unverified text-only", async () => {
    await setupDeepSeekProvider();

    const { capabilities } = await resolveCapabilities(
      "custom-api:deepseek/deepseek-reasoner",
    );

    expect(capabilities.verified).toBe(false);
    expect(capabilities.modalities).toEqual(["text"]);
  });

  it("keeps the declaration alive when the connection uses the Responses protocol", async () => {
    await setupDeepSeekProvider("openai-responses");

    const { selection, capabilities } = await resolveCapabilities(
      "custom-api:deepseek/deepseek-flash",
    );

    // Declaring `image` must survive the protocol-specific rewrite to
    // @ai-sdk/open-responses; this is the reported regression.
    expect(selection.provider.npm).toBe("@ai-sdk/open-responses");
    expect(capabilities.verified).toBe(true);
    expect(capabilities.status).toBe("verified");
    expect(capabilities.modalities).toContain("image");
  });

  it("narrows Responses input to the documented DeepSeek endpoint limits", async () => {
    await setupDeepSeekProvider("openai-responses");

    const { capabilities } = await resolveCapabilities(
      "custom-api:deepseek/deepseek-flash",
    );
    const { assertMediaCapabilities } =
      await import("../media-capabilities.js");

    // Vision limits: 32 MiB per inline image; Synax inlines assets as base64,
    // so the 48 MiB request-body limit is the binding total.
    expect(capabilities.maxFileBytes).toBe(32 * 1024 * 1024);
    expect(capabilities.maxTotalBytes).toBe(48 * 1024 * 1024);
    expect(capabilities.mediaTypes).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]);

    expect(() =>
      assertMediaCapabilities(
        [asset("shot.png", "image/png", 1024)],
        capabilities,
      ),
    ).not.toThrow();
    // The Responses guide states file inputs are unsupported.
    expect(() =>
      assertMediaCapabilities(
        [asset("paper.pdf", "application/pdf", 1024)],
        capabilities,
      ),
    ).toThrow(/cannot receive paper\.pdf/);
  });
});

function asset(filename: string, mediaType: string, size: number) {
  return {
    id: `asset_${"a".repeat(32)}`,
    projectId: "project-1",
    filename,
    mediaType,
    size,
    sha256: "0".repeat(64),
    createdAt: new Date().toISOString(),
  };
}
