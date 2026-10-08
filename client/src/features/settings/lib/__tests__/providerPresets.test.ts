import { describe, expect, it } from "vitest";
import type {
  GlobalConfig,
  ProviderDef,
} from "../../../../shared/contracts/config";
import {
  API_FORMAT_OPTIONS,
  API_PROVIDER_PRESETS,
  apiFormatLabel,
  applyProtocolDefaults,
  buildApiDrafts,
  configuredModelList,
  createCustomDraft,
  createDraftFromPreset,
  draftToConnection,
  draftToProviderDef,
  effectiveReasoningEfforts,
  parseReasoningEfforts,
  mergeModelOptions,
  modelsWithContextLimit,
  modelOptionLabel,
  providerDisplayLabel,
  providerReasoningEfforts,
  selectDefaultModel,
  toggleModelContextLimit,
  toggleModelSelection,
  upsertDraft,
  type ApiProviderDraft,
} from "../providerPresets";
import { validateProviderDraft } from "../validation";

describe("provider display labels", () => {
  it("resolves the configured provider name instead of the internal id", () => {
    const providers: Pick<ProviderDef, "id" | "label">[] = [
      { id: "custom-api:1790651255292", label: "DeepSeek" },
    ];

    expect(providerDisplayLabel(providers, "custom-api:1790651255292")).toBe(
      "DeepSeek",
    );
    expect(
      modelOptionLabel(providers, "custom-api:1790651255292", "deepseek-flash"),
    ).toBe("DeepSeek · deepseek-flash");
  });

  it("falls back to the preset name, then to the model name alone", () => {
    expect(providerDisplayLabel([], "custom-api:openrouter")).toBe("OpenRouter");
    expect(providerDisplayLabel([], "custom-api:1790651255292")).toBeNull();
    expect(
      modelOptionLabel([], "custom-api:1790651255292", "deepseek-flash"),
    ).toBe("deepseek-flash");
    expect(providerDisplayLabel([], null)).toBeNull();
  });
});

function makeProvider(): ProviderDef {
  return {
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
        contextLimit: 1_000_000,
      },
      { id: "deepseek-reasoner", label: "deepseek-reasoner" },
    ],
  };
}

function makeConfig(
  provider: ProviderDef,
  extra?: Record<string, unknown>,
): GlobalConfig {
  return {
    version: 1,
    providers: [provider],
    defaultProviderId: "opencode-acp",
    defaultApiProviderId: provider.id,
    enabledAcpProviderIds: ["opencode-acp"],
    providerConnections: {
      [provider.id]: {
        providerId: provider.id,
        baseUrl: "https://api.deepseek.com",
        apiKeyMasked: "sk-****",
        extra: {
          kind: "api",
          apiFormat: "openai",
          model: "deepseek-chat",
          ...extra,
        },
      },
    },
    mcpServers: [],
    limits: { maxAgentsPerProject: 10, agentTimeoutMs: 300_000 },
    features: { allowProjectConnectionOverride: true },
    updatedAt: new Date().toISOString(),
    updatedBy: "test",
  };
}

describe("providerPresets model metadata", () => {
  it("keeps only text, image and video declarations across configuration round trips", () => {
    const provider = makeProvider();
    provider.models[0].inputModalities = ["text", "image", "video", "audio", "file"];
    provider.models[0].outputModalities = ["text", "image", "video", "audio", "file"];
    const draft = buildApiDrafts(makeConfig(provider), [provider]).find(
      (item) => item.id === provider.id,
    )!;
    expect(draft.modelMeta["deepseek-chat"].inputModalities).toEqual(["text", "image", "video"]);
    expect(draft.modelMeta["deepseek-chat"].outputModalities).toEqual(["text", "image", "video"]);
    const savedModel = draftToProviderDef(draft).models.find(
      (model) => model.id === "deepseek-chat",
    )!;
    expect(savedModel.inputModalities).toEqual(["text", "image", "video"]);
    expect(savedModel.outputModalities).toEqual(["text", "image", "video"]);
    expect(provider.models[1].inputModalities).toBeUndefined();
    expect(draft.modelMeta["deepseek-reasoner"]).toBeUndefined();
  });

  it("preserves typed model metadata when inserting and merging drafts", () => {
    const draft: ApiProviderDraft = {
      ...createCustomDraft([]),
      model: "media-model",
      models: ["media-model", "chat-model"],
      modelMeta: {
        "media-model": {
          inputModalities: ["text", "image"],
          outputModalities: ["image", "video"],
          capabilities: ["image_generation", "video_generation"],
          media: {
            operations: ["text-to-image", "text-to-video"],
            parameters: { quality: { values: ["low", "high"] } },
          },
        },
      },
    };
    const [inserted] = upsertDraft([], draft);
    expect(inserted.modelMeta["media-model"]).toEqual(draft.modelMeta["media-model"]);
    const [merged] = upsertDraft([inserted], {
      ...draft,
      modelMeta: { "chat-model": { contextLimit: 400_000, inputModalities: ["text"] } },
    });
    expect(merged.modelMeta).toEqual({
      ...draft.modelMeta,
      "chat-model": { contextLimit: 400_000, inputModalities: ["text"] },
    });
  });

  it("normalizes unordered old effort lists and writes a canonical set", () => {
    const source = ["max", "low", "high", "low", "invalid", "none", "medium", "xhigh"];
    expect(parseReasoningEfforts(source)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(source[0]).toBe("max");
    expect(parseReasoningEfforts(null)).toEqual([]);
    expect(parseReasoningEfforts(["invalid"])).toEqual([]);
    const provider = makeProvider();
    expect(effectiveReasoningEfforts(makeConfig(provider, { reasoningEfforts: source }), provider.id)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(draftToConnection({ ...createCustomDraft([]), reasoningEfforts: ["high", "low", "high"] }).extra?.reasoningEfforts).toEqual(["low", "high"]);
  });
  it("round-trips output modalities for arbitrary model IDs", () => {
    const draft = {
      ...createCustomDraft([]),
      model: "future-model",
      models: ["future-model"],
      modelMeta: {
        "future-model": {
          inputModalities: ["text", "image"] as const,
          outputModalities: ["text", "image", "video"] as const,
        },
      },
    };
    const provider = draftToProviderDef({
      ...draft,
      modelMeta: {
        "future-model": {
          inputModalities: [...draft.modelMeta["future-model"].inputModalities],
          outputModalities: [
            ...draft.modelMeta["future-model"].outputModalities,
          ],
        },
      },
    });
    expect(provider.models[0].outputModalities).toEqual([
      "text",
      "image",
      "video",
    ]);
    expect(
      buildApiDrafts(makeConfig(provider), [provider]).find(
        (draft) => draft.id === provider.id,
      )!.modelMeta["future-model"].outputModalities,
    ).toEqual(["text", "image", "video"]);
  });

  it("round-trips generation capabilities and media operations", () => {
    const provider = draftToProviderDef({
      ...createCustomDraft([]),
      model: "media-model",
      models: ["media-model"],
      modelMeta: {
        "media-model": {
          capabilities: ["image_generation", "video_generation"],
          media: {
            operations: ["text-to-image", "image-to-image", "text-to-video"],
          },
        },
      },
    });
    const draft = buildApiDrafts(
      makeConfig(provider, { apiKey: "configured" }),
      [provider],
    ).find((item) => item.id === provider.id);
    expect(draft?.modelMeta["media-model"]?.capabilities).toEqual([
      "image_generation",
      "video_generation",
    ]);
    expect(draft?.modelMeta["media-model"]?.media?.operations).toEqual([
      "text-to-image",
      "image-to-image",
      "text-to-video",
    ]);
  });

  it("retains a custom media adapter and rejects a generation model without operations", () => {
    const draft: ApiProviderDraft = {
      ...createCustomDraft([]),
      id: 'custom-api:studio',
      apiKeyMasked: '****',
      baseUrl: 'https://studio.example/api',
      model: 'image-model',
      models: ['image-model'],
      mediaAdapter: 'openrouter',
      modelMeta: {
        'image-model': {
          capabilities: ['image_generation'],
          media: { operations: ['text-to-image'], parameters: { quality: { values: ['low', 'high'] } } },
        },
      },
    };
    expect(validateProviderDraft(draft)).toEqual([]);
    const provider = draftToProviderDef(draft);
    const connection = draftToConnection(draft);
    expect(connection.mediaAdapter).toBe('openrouter');
    const loaded = buildApiDrafts(makeConfig(provider, { mediaAdapter: 'openrouter' }), [provider]);
    expect(loaded.find((item) => item.id === provider.id)?.modelMeta['image-model']?.media?.parameters?.quality.values).toEqual(['low', 'high']);
    expect(validateProviderDraft({ ...draft, modelMeta: { 'image-model': { capabilities: ['image_generation'], media: { operations: [] } } } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ field: 'model' })]));
  });
  it("round-trips model contextLimit and allowed reasoning efforts", () => {
    const provider = makeProvider();
    const config = makeConfig(provider, { reasoningEfforts: ["high", "max"] });
    const drafts = buildApiDrafts(config, [provider]);
    const draft = drafts.find((d) => d.id === provider.id);
    expect(draft).toBeDefined();
    expect(draft!.modelMeta["deepseek-chat"]?.contextLimit).toBe(1_000_000);
    expect(draft!.reasoningEfforts).toEqual(["high", "max"]);

    const def = draftToProviderDef(draft!);
    const connection = draftToConnection(draft!);
    expect(def.models.find((m) => m.id === "deepseek-chat")?.contextLimit).toBe(
      1_000_000,
    );
    expect(connection.extra?.reasoningEfforts).toEqual(["high", "max"]);
    expect(connection.extra?.model).toBe("deepseek-chat");
  });

  it("falls back to a legacy single default effort and to all levels when unrestricted", () => {
    const provider = makeProvider();
    const config = makeConfig(provider, { defaultReasoningEffort: "high" });
    expect(providerReasoningEfforts(config, provider.id)).toEqual(["high"]);
    expect(effectiveReasoningEfforts(config, provider.id)).toEqual(["high"]);

    const unrestricted = makeConfig(provider, {});
    expect(providerReasoningEfforts(unrestricted, provider.id)).toEqual([]);
    expect(effectiveReasoningEfforts(unrestricted, provider.id)).toHaveLength(
      6,
    );
  });

  it("upsertDraft preserves metadata when only the model changes", () => {
    const provider = makeProvider();
    const config = makeConfig(provider, {
      reasoningEfforts: ["medium", "high"],
    });
    const drafts = buildApiDrafts(config, [provider]);
    const draft = drafts.find((d) => d.id === provider.id)!;
    const next: ApiProviderDraft = {
      ...draft,
      model: "deepseek-reasoner",
      modelMeta: {},
    };
    const merged = upsertDraft(drafts, next);
    const saved = merged.find((d) => d.id === provider.id)!;
    expect(saved.model).toBe("deepseek-reasoner");
    expect(saved.modelMeta["deepseek-chat"]?.contextLimit).toBe(1_000_000);
    expect(saved.reasoningEfforts).toEqual(["medium", "high"]);
  });
});

describe("per-model context window", () => {
  function draftWithBothModels(): ApiProviderDraft {
    const provider = makeProvider();
    const draft = buildApiDrafts(makeConfig(provider, {}), [provider]).find(
      (d) => d.id === provider.id,
    )!;
    return {
      ...draft,
      models: ["deepseek-chat", "deepseek-reasoner"],
      modelMeta: { "deepseek-chat": { contextLimit: 1_000_000 } },
    };
  }

  it("enables and disables the 1M window per model without touching siblings", () => {
    const draft = draftWithBothModels();
    expect(modelsWithContextLimit(draft)).toEqual([
      { id: "deepseek-chat", contextLimit: 1_000_000 },
    ]);

    const enabled = toggleModelContextLimit(draft, "deepseek-reasoner", true);
    expect(modelsWithContextLimit(enabled)).toEqual([
      { id: "deepseek-chat", contextLimit: 1_000_000 },
      { id: "deepseek-reasoner", contextLimit: 1_000_000 },
    ]);

    const disabled = toggleModelContextLimit(enabled, "deepseek-chat", false);
    expect(disabled.modelMeta["deepseek-chat"]?.contextLimit).toBeUndefined();
    expect(disabled.modelMeta["deepseek-reasoner"]?.contextLimit).toBe(
      1_000_000,
    );
    expect(modelsWithContextLimit(disabled)).toEqual([
      { id: "deepseek-reasoner", contextLimit: 1_000_000 },
    ]);
  });

  it("stores only the flagged models in the provider definition", () => {
    const draft = draftWithBothModels();
    const def = draftToProviderDef(
      toggleModelContextLimit(draft, "deepseek-reasoner", true),
    );
    expect(def.models.find((m) => m.id === "deepseek-chat")?.contextLimit).toBe(
      1_000_000,
    );
    expect(
      def.models.find((m) => m.id === "deepseek-reasoner")?.contextLimit,
    ).toBe(1_000_000);

    const single = draftToProviderDef(draft);
    expect(
      single.models.find((m) => m.id === "deepseek-chat")?.contextLimit,
    ).toBe(1_000_000);
    expect(
      single.models.find((m) => m.id === "deepseek-reasoner")?.contextLimit,
    ).toBeUndefined();
  });

  it("keeps input modalities while the window changes and honours custom windows", () => {
    const draft = draftWithBothModels();
    const withModalities: ApiProviderDraft = {
      ...draft,
      modelMeta: {
        ...draft.modelMeta,
        "deepseek-reasoner": { inputModalities: ["text", "image"] },
      },
    };
    const toggled = toggleModelContextLimit(
      withModalities,
      "deepseek-reasoner",
      true,
    );
    expect(toggled.modelMeta["deepseek-reasoner"]).toEqual({
      inputModalities: ["text", "image"],
      contextLimit: 1_000_000,
    });

    const custom = toggleModelContextLimit(
      toggled,
      "deepseek-reasoner",
      true,
      400_000,
    );
    expect(custom.modelMeta["deepseek-reasoner"]?.contextLimit).toBe(400_000);
    expect(custom.modelMeta["deepseek-reasoner"]?.inputModalities).toEqual([
      "text",
      "image",
    ]);
  });

  it("ignores blank model ids", () => {
    const draft = draftWithBothModels();
    expect(toggleModelContextLimit(draft, "  ", true)).toBe(draft);
  });
});

describe("provider protocol selection", () => {
  it("offers the three chat protocols plus Jev System One", () => {
    expect(API_FORMAT_OPTIONS.map((option) => option.key)).toEqual([
      "openai",
      "openai-responses",
      "anthropic",
      "jev",
    ]);
    expect(apiFormatLabel("openai-responses")).toBe("OpenAI Responses");
    expect(apiFormatLabel("anthropic")).toBe("Anthropic Messages");
    expect(apiFormatLabel("jev")).toBe("Jev / TypeSafe System One");
  });

  it("switches untouched defaults to the new protocol and keeps edited values", () => {
    const preset = API_PROVIDER_PRESETS.find((p) => p.providerId === "openai")!;
    const draft = createDraftFromPreset(preset);

    const untouched = applyProtocolDefaults(draft, "anthropic");
    expect(untouched.format).toBe("anthropic");
    expect(untouched.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(untouched.model).toBe("claude-3-5-sonnet-latest");

    const responses = applyProtocolDefaults(draft, "openai-responses");
    expect(responses.format).toBe("openai-responses");
    expect(responses.baseUrl).toBe("https://api.openai.com/v1");
    expect(responses.model).toBe("gpt-4o-mini");

    const edited = applyProtocolDefaults(
      {
        ...draft,
        model: "gpt-5.4-codex",
        baseUrl: "https://xuanji.example.com/v1",
      },
      "openai-responses",
    );
    expect(edited.format).toBe("openai-responses");
    expect(edited.baseUrl).toBe("https://xuanji.example.com/v1");
    expect(edited.model).toBe("gpt-5.4-codex");

    const provider = makeProvider();
    const customDraft = buildApiDrafts(makeConfig(provider, {}), [
      provider,
    ]).find((d) => d.id === provider.id)!;
    expect(applyProtocolDefaults(customDraft, "anthropic").model).toBe(
      "deepseek-chat",
    );

    const openRouter = API_PROVIDER_PRESETS.find(
      (preset) => preset.providerId === "custom-api:openrouter",
    )!;
    const openRouterDraft = createDraftFromPreset(openRouter);
    const jev = applyProtocolDefaults(openRouterDraft, "jev");
    expect(jev.format).toBe("jev");
    expect(jev.baseUrl).toBe("https://openrouter.ai/api");
    expect(jev.model).toBe("jev-latest");

    const existingV1 = applyProtocolDefaults(
      { ...openRouterDraft, baseUrl: "https://openrouter.ai/api/v1" },
      "jev",
    );
    expect(existingV1.baseUrl).toBe("https://openrouter.ai/api");
  });

  it("starts a custom endpoint without an assumed model", () => {
    const draft = createCustomDraft([]);

    expect(draft.model).toBe("");
    expect(draft.models).toEqual([]);
    expect(draft.modelOptions).toEqual([]);
    expect(applyProtocolDefaults(draft, "anthropic").model).toBe("");
  });

  it("does not synthesize a model when loading an empty custom endpoint", () => {
    const provider: ProviderDef = {
      id: "custom-api:empty",
      label: "Empty custom endpoint",
      status: "live",
      kind: "api",
      caps: { canFollowUp: true, canCancel: true },
      models: [],
    };
    const config = makeConfig(provider);
    config.providerConnections[provider.id]!.extra = {
      kind: "api",
      apiFormat: "openai",
    };

    const draft = buildApiDrafts(config, [provider]).find(
      (item) => item.id === provider.id,
    )!;
    expect(draft.model).toBe("");
    expect(draft.models).toEqual([]);
  });

  it("persists the selected protocol in the connection extra", () => {
    const provider = makeProvider();
    const draft = buildApiDrafts(makeConfig(provider, {}), [provider]).find(
      (d) => d.id === provider.id,
    )!;
    const connection = draftToConnection({
      ...draft,
      format: "openai-responses",
    });
    expect(connection.extra?.apiFormat).toBe("openai-responses");
  });

  it("keeps discovered models as picker candidates until they are selected", () => {
    const provider = makeProvider();
    const draft = buildApiDrafts(makeConfig(provider, {}), [provider]).find(
      (d) => d.id === provider.id,
    )!;
    expect(draft.models).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(draft.modelOptions).toEqual(["deepseek-chat", "deepseek-reasoner"]);

    // 发现回来的模型只进入候选池，不会自动变成已配置模型
    const widened = {
      ...draft,
      modelOptions: mergeModelOptions(
        ["gpt-4o", "gpt-4.1"],
        draft.modelOptions,
      ),
    };
    expect(widened.modelOptions).toEqual([
      "gpt-4o",
      "gpt-4.1",
      "deepseek-chat",
      "deepseek-reasoner",
    ]);
    expect(configuredModelList(widened)).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
    ]);

    const selected = toggleModelSelection(widened, "gpt-4o");
    expect(configuredModelList(selected)).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
      "gpt-4o",
    ]);

    const deselected = toggleModelSelection(selected, "gpt-4o");
    expect(configuredModelList(deselected)).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
    ]);
  });

  it("keeps the default model configured and promotes a new default", () => {
    const provider = makeProvider();
    const draft = buildApiDrafts(makeConfig(provider, {}), [provider]).find(
      (d) => d.id === provider.id,
    )!;
    const promoted = selectDefaultModel(
      toggleModelSelection(draft, "gpt-4o"),
      "gpt-4o",
    );

    expect(promoted.model).toBe("gpt-4o");
    expect(promoted.models).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
      "gpt-4o",
    ]);
    // 默认模型不能被取消勾选，非默认模型可以
    expect(toggleModelSelection(promoted, "gpt-4o")).toBe(promoted);
    expect(
      configuredModelList(toggleModelSelection(promoted, "deepseek-chat")),
    ).toEqual(["deepseek-reasoner", "gpt-4o"]);
  });

  it("persists only the selected models for the provider", () => {
    const provider = makeProvider();
    const draft = buildApiDrafts(makeConfig(provider, {}), [provider]).find(
      (d) => d.id === provider.id,
    )!;
    // 仅出现在候选池里的模型不会被保存
    const withCandidate = {
      ...draft,
      modelOptions: mergeModelOptions(draft.modelOptions, ["gpt-4o"]),
    };
    expect(withCandidate.modelOptions).toContain("gpt-4o");
    expect(draftToProviderDef(withCandidate).models.map((m) => m.id)).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
    ]);

    // 勾选后才写入 provider 定义
    expect(
      draftToProviderDef(
        toggleModelSelection(withCandidate, "gpt-4o"),
      ).models.map((m) => m.id),
    ).toEqual(["deepseek-chat", "deepseek-reasoner", "gpt-4o"]);
  });
});
