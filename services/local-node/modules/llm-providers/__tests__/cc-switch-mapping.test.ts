import { describe, expect, it } from "vitest";
import {
  mapCcSwitchRecords,
  normalizeCcSwitchApiFormat,
  normalizeCcSwitchModelId,
} from "../cc-switch-mapping.js";
import type { CcSwitchProviderRecord } from "../cc-switch-contracts.js";

const CLAUDE_KEY = "sk-ant-abcdefghijklmnop";
const CODEX_KEY = "sk-openai-abcdefghijklmnop";

function claudeRecord(overrides: Partial<CcSwitchProviderRecord> = {}): CcSwitchProviderRecord {
  return {
    appType: "claude",
    id: "claude-gateway-1",
    name: "My Gateway",
    category: null,
    isCurrent: true,
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://gateway.example.test/",
        ANTHROPIC_AUTH_TOKEN: CLAUDE_KEY,
        ANTHROPIC_MODEL: "DeepSeek-V4.1-Flash-1017[1M]",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "DeepSeek-V4.1-Flash-1017[1M]",
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "DeepSeek-V4.1-Flash-1017",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3-flashx",
        CLAUDE_CODE_SUBAGENT_MODEL: "DeepSeek-V4.1-Flash-1017[1M]",
      },
      model: "opus",
    },
    meta: { apiFormat: "anthropic", endpointAutoSelect: true },
    ...overrides,
  };
}

const CODEX_TOML = `model_provider = "custom"
model = "gpt-6-sol"

[model_providers.custom]
name = "Rabbit"
base_url = "https://rabbit.example.test/v1"
wire_api = "responses"
requires_openai_auth = false
`;

function codexRecord(overrides: Partial<CcSwitchProviderRecord> = {}): CcSwitchProviderRecord {
  return {
    appType: "codex",
    id: "codex-rabbit",
    name: "Rabbit",
    category: null,
    isCurrent: false,
    settingsConfig: {
      auth: { OPENAI_API_KEY: CODEX_KEY },
      config: CODEX_TOML,
      modelCatalog: {
        models: [
          { model: "gpt-6-sol", contextWindow: 500_000 },
          { model: "deepseek-v4-flash", contextWindow: 1_000_000 },
        ],
      },
    },
    meta: { apiFormat: "openai_responses" },
    ...overrides,
  };
}

describe("cc-switch mapping", () => {
  it("normalizes protocol names and 1M model suffixes", () => {
    expect(normalizeCcSwitchApiFormat("openai_chat")).toBe("openai");
    expect(normalizeCcSwitchApiFormat("openai_responses")).toBe("openai-responses");
    expect(normalizeCcSwitchApiFormat("anthropic")).toBe("anthropic");
    expect(normalizeCcSwitchApiFormat("unknown")).toBeUndefined();
    expect(normalizeCcSwitchModelId("deepseek-v4-flash[1M]")).toBe("deepseek-v4-flash");
  });

  it("maps a Claude Code gateway provider", () => {
    const { candidates, skipped, unsupported } = mapCcSwitchRecords([claudeRecord()]);

    expect(skipped).toEqual([]);
    expect(unsupported).toEqual([]);
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.key).toBe("claude:claude-gateway-1");
    expect(candidate.appType).toBe("claude");
    expect(candidate.label).toBe("My Gateway");
    expect(candidate.baseUrl).toBe("https://gateway.example.test");
    expect(candidate.apiFormat).toBe("anthropic");
    expect(candidate.apiKey).toBe(CLAUDE_KEY);
    expect(candidate.apiKeyMasked).toContain("****");
    expect(candidate.apiKeyMasked).not.toContain(CLAUDE_KEY);
    expect(candidate.defaultModel).toBe("DeepSeek-V4.1-Flash-1017");
    expect(candidate.models.map((model) => model.id)).toEqual([
      "DeepSeek-V4.1-Flash-1017",
      "glm-5.3-flashx",
    ]);
    expect(candidate.models[0]?.contextLimit).toBe(1_000_000);
  });

  it("follows the declared protocol for a Claude entry that speaks OpenAI", () => {
    const { candidates } = mapCcSwitchRecords([
      claudeRecord({ meta: { apiFormat: "openai_chat" } }),
    ]);

    expect(candidates[0]?.apiFormat).toBe("openai");
  });

  it("maps a Codex provider from its TOML config and model catalog", () => {
    const { candidates } = mapCcSwitchRecords([codexRecord()]);

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.key).toBe("codex:codex-rabbit");
    expect(candidate.baseUrl).toBe("https://rabbit.example.test/v1");
    expect(candidate.apiFormat).toBe("openai-responses");
    expect(candidate.defaultModel).toBe("gpt-6-sol");
    expect(candidate.models).toEqual([
      { id: "gpt-6-sol", contextLimit: 500_000 },
      { id: "deepseek-v4-flash", contextLimit: 1_000_000 },
    ]);
  });

  it("reads wire_api=chat as the OpenAI chat protocol", () => {
    const { candidates } = mapCcSwitchRecords([
      codexRecord({
        settingsConfig: {
          auth: { OPENAI_API_KEY: CODEX_KEY },
          config: CODEX_TOML.replace('wire_api = "responses"', 'wire_api = "chat"'),
        },
      }),
    ]);

    expect(candidates[0]?.apiFormat).toBe("openai");
  });

  it("skips official entries that carry no key", () => {
    const { candidates, skipped } = mapCcSwitchRecords([
      claudeRecord({
        id: "claude-official",
        name: "Claude Official",
        category: "official",
        settingsConfig: { env: {} },
      }),
    ]);

    expect(candidates).toEqual([]);
    expect(skipped).toEqual([
      expect.objectContaining({ key: "claude:claude-official", reason: expect.stringContaining("官方") }),
    ]);
  });

  it("reports unsupported CLI apps instead of importing them", () => {
    const { candidates, unsupported } = mapCcSwitchRecords([
      {
        appType: "hermes",
        id: "hermes-1",
        name: "Hermes",
        category: null,
        isCurrent: false,
        settingsConfig: { base_url: "https://hermes.example.test", api_key: "k" },
        meta: {},
      },
    ]);

    expect(candidates).toEqual([]);
    expect(unsupported).toEqual([expect.objectContaining({ key: "hermes:hermes-1" })]);
  });

  it("skips a Codex entry whose TOML has no base_url", () => {
    const { skipped } = mapCcSwitchRecords([
      codexRecord({
        settingsConfig: { auth: { OPENAI_API_KEY: CODEX_KEY }, config: "model = \"gpt-6-sol\"\n" },
      }),
    ]);

    expect(skipped[0]?.reason).toBe("未配置 model_providers base_url");
  });

  it("skips entries without an API key", () => {
    const { candidates, skipped } = mapCcSwitchRecords([
      claudeRecord({ settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://x.example.test" } } }),
    ]);

    expect(candidates).toEqual([]);
    expect(skipped[0]?.reason).toBe("未配置 ANTHROPIC_AUTH_TOKEN");
  });
});
