import { describe, expect, it } from "vitest";
import { createDefaultGlobalConfig } from "../../../infrastructure/runtime/config/config-defaults.js";
import type {
  GlobalConfig,
  ProviderConnection,
  ProviderDef,
} from "../../../infrastructure/runtime/config/config-types.js";
import type {
  ResolveLlmSelectionInput,
  RuntimeCatalog,
} from "../../../infrastructure/llm-runtime/types.js";
import {
  describeSubagentModelOptions,
  listSubagentModelOptions,
  matchSubagentModelOption,
  subagentModelError,
  type SubagentModelOption,
} from "../subagent-models.js";

const catalog: RuntimeCatalog = {
  providers: [
    {
      id: "openai",
      label: "OpenAI",
      npm: "@ai-sdk/openai",
      api: "https://api.openai.com/v1",
      env: ["OPENAI_API_KEY"],
      supported: true,
      models: [
        { id: "gpt-4o-mini", label: "GPT-4o mini", toolCall: true },
        { id: "gpt-4o", label: "GPT-4o", toolCall: true },
      ],
    },
    {
      id: "anthropic",
      label: "Anthropic",
      npm: "@ai-sdk/anthropic",
      api: "https://api.anthropic.com/v1",
      env: ["ANTHROPIC_API_KEY"],
      supported: true,
      models: [{ id: "claude-3-5-sonnet-latest", label: "Claude 3.5 Sonnet" }],
    },
  ],
  fetchedAt: "2026-01-01T00:00:00.000Z",
  source: "snapshot",
};

const openai: ProviderDef = {
  ...createDefaultGlobalConfig().providers.find((provider) => provider.id === "openai")!,
  models: [
    { id: "gpt-4o-mini", label: "GPT-4o mini", isDefault: true },
    { id: "gpt-4o", label: "GPT-4o" },
  ],
};

const connection = (providerId: string, overrides: Partial<ProviderConnection> = {}): ProviderConnection =>
  ({ providerId, baseUrl: `https://api.${providerId}.com/v1`, apiKey: "sk-test", ...overrides });

function selectionInput(globalConfig: GlobalConfig): ResolveLlmSelectionInput {
  return { catalog, globalConfig, projectConfig: null, purpose: "agent" };
}

const option = (providerId: string, modelId: string): SubagentModelOption =>
  ({ ref: `${providerId}/${modelId}`, providerId, modelId, label: `${modelId} label` });

describe("subagent model options", () => {
  it("lists only models of providers a child turn can actually authenticate with", () => {
    expect(listSubagentModelOptions(selectionInput(createDefaultGlobalConfig()))).toEqual([]);

    const configured = listSubagentModelOptions(selectionInput({
      ...createDefaultGlobalConfig(),
      providers: [openai],
      providerConnections: { openai: connection("openai") },
      defaultApiProviderId: "openai",
    }));
    expect(configured.map((item) => item.ref)).toEqual(["openai/gpt-4o-mini", "openai/gpt-4o"]);
  });

  it("keeps a project-pinned default selectable and de-duplicated", () => {
    const options = listSubagentModelOptions(selectionInput({
      ...createDefaultGlobalConfig(),
      providers: [openai],
      providerConnections: {
        openai: connection("openai", { extra: { model: "gpt-4o" } }),
      },
      defaultApiProviderId: "openai",
    }));
    expect(options.map((item) => item.ref)).toEqual(["openai/gpt-4o", "openai/gpt-4o-mini"]);
  });

  it("matches exact refs and an unambiguous bare model ID", () => {
    const options = [option("openai", "gpt-4o-mini"), option("anthropic", "claude-3-5-sonnet-latest")];
    expect(matchSubagentModelOption(options, "openai/gpt-4o-mini")?.ref).toBe("openai/gpt-4o-mini");
    expect(matchSubagentModelOption(options, " GPT-4O-MINI ")?.ref).toBe("openai/gpt-4o-mini");
    expect(matchSubagentModelOption(options, "claude-3-5-sonnet-latest")?.ref)
      .toBe("anthropic/claude-3-5-sonnet-latest");
  });

  it("refuses ambiguous bare IDs and unknown refs instead of picking one", () => {
    const options = [option("openai", "shared-model"), option("anthropic", "shared-model")];
    expect(matchSubagentModelOption(options, "shared-model")).toBeNull();
    expect(matchSubagentModelOption(options, "openai/missing")).toBeNull();
  });

  it("names thinking modes as thinking modes", () => {
    const error = subagentModelError("deep", [option("openai", "gpt-4o-mini")]);
    expect(error.message).toContain("thinking mode, not a model");
    expect(error.message).toContain("profile.thinkingMode");
    expect(error.message).toContain("openai/gpt-4o-mini");
  });

  it("lists the exact accepted refs for an unknown model", () => {
    const message = subagentModelError("deepseek-chat", [option("openai", "gpt-4o-mini")]).message;
    expect(message).toContain("'deepseek-chat' is not a configured model");
    expect(message).toContain("openai/gpt-4o-mini");
    expect(message).toContain("omit profile.model");
  });

  it("distinguishes a stale custom subagent configuration", () => {
    const message = subagentModelError("openai/gpt-3.5", [], { templateName: "Reviewer" }).message;
    expect(message).toContain("Custom subagent 'Reviewer'");
    expect(message).toContain("Settings > Subagents");
  });

  it("describes the deterministic choice in the tool definition", () => {
    expect(describeSubagentModelOptions([])).toContain("profile.model must be omitted");
    const text = describeSubagentModelOptions([option("openai", "gpt-4o-mini")]);
    expect(text).toContain("openai/gpt-4o-mini");
    expect(text).toContain("thinkingMode");
  });
});
