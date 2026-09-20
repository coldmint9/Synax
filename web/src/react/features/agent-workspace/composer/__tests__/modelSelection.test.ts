import { describe, expect, it } from "vitest";
import type {
  GlobalConfig,
  ProviderDef,
} from "../../../../../lib/contracts/config";
import {
  buildAgentModelOptions,
  formatModelReference,
} from "../modelSelection";

const baseGlobalConfig: GlobalConfig = {
  version: 1,
  providers: [],
  defaultProviderId: "cursor-acp",
  defaultApiProviderId: "openai",
  enabledAcpProviderIds: ["cursor-acp"],
  providerConnections: {},
  limits: { maxAgentsPerProject: 1, agentTimeoutMs: 1 },
  features: { allowProjectConnectionOverride: true },
  updatedAt: "2026-01-01T00:00:00.000Z",
  updatedBy: "test",
};

const cursorProvider: ProviderDef = {
  id: "cursor-acp",
  label: "Cursor ACP",
  status: "live",
  kind: "acp",
  caps: { canFollowUp: true, canCancel: true },
  models: [{ id: "cursor-default", label: "Cursor Default", isDefault: true }],
};

describe("buildAgentModelOptions", () => {
  it("hides registered ACP providers before discovery", () => {
    expect(
      buildAgentModelOptions(baseGlobalConfig, [cursorProvider]).acpEndpoints,
    ).toEqual([]);
  });

  it.each([
    { status: "missing", installed: false, handshakeOk: false },
    { status: "available", installed: true, handshakeOk: false },
    { status: "available", installed: false, handshakeOk: true },
  ] as const)("excludes unusable discovery results: %j", (result) => {
    expect(
      buildAgentModelOptions(
        baseGlobalConfig,
        [cursorProvider],
        [
          {
            id: "cursor-acp",
            label: "Cursor ACP",
            command: "agent",
            selected: false,
            compatibility: "",
            ...result,
          },
        ],
      ).acpEndpoints,
    ).toEqual([]);
  });

  it("offers discovered ACP without global settings or enable toggles", () => {
    const discovery = [
      {
        id: "cursor-acp",
        label: "Cursor ACP",
        command: "agent",
        status: "available" as const,
        installed: true,
        handshakeOk: true,
        selected: false,
        compatibility: "",
      },
    ];
    for (const config of [
      null,
      { ...baseGlobalConfig, enabledAcpProviderIds: [] },
    ]) {
      expect(
        buildAgentModelOptions(config, [cursorProvider], discovery)
          .acpEndpoints,
      ).toEqual([
        {
          kind: "acp",
          providerId: "cursor-acp",
          modelId: "cursor-default",
          label: "Cursor Default",
        },
      ]);
    }
  });

  it("expands ACP provider models from discovery catalog", () => {
    const { acpEndpoints } = buildAgentModelOptions(
      baseGlobalConfig,
      [cursorProvider],
      [
        {
          id: "cursor-acp",
          label: "Cursor ACP",
          command: "agent",
          status: "available",
          installed: true,
          handshakeOk: true,
          selected: false,
          compatibility: "",
          models: [
            { id: "auto", label: "Auto" },
            { id: "gpt-5.4", label: "GPT-5.4" },
          ],
        },
      ],
    );

    expect(acpEndpoints).toEqual([
      { kind: "acp", providerId: "cursor-acp", modelId: "auto", label: "Auto" },
      {
        kind: "acp",
        providerId: "cursor-acp",
        modelId: "gpt-5.4",
        label: "GPT-5.4",
      },
    ]);
  });
});

describe("formatModelReference ACP provider/model refs", () => {
  it("formats native and adapter-backed ACP engines as providerId/modelId", () => {
    expect(formatModelReference("codex-acp", "gpt-5.4")).toBe(
      "codex-acp/gpt-5.4",
    );
    expect(formatModelReference("pi-acp", "default")).toBe("pi-acp/default");
    expect(formatModelReference("cursor-acp", "auto")).toBe("cursor-acp/auto");
    expect(formatModelReference("openai", "gpt-5.4")).toBe("openai/gpt-5.4");
    expect(formatModelReference("custom-api:kiro-local", "claude-opus-5")).toBe(
      "custom-api:kiro-local/claude-opus-5",
    );
    expect(
      formatModelReference(
        "custom-api:kiro-local",
        "custom-api:kiro-local/claude-opus-5",
      ),
    ).toBe("custom-api:kiro-local/claude-opus-5");
    expect(formatModelReference(null, "gpt-5.4")).toBe("gpt-5.4");
    expect(formatModelReference("codex-acp", null)).toBeUndefined();
  });

  it("expands pi-acp endpoints from discovery catalog when enabled", () => {
    const config: GlobalConfig = {
      ...baseGlobalConfig,
      enabledAcpProviderIds: ["pi-acp"],
      defaultProviderId: "pi-acp",
    };
    const piProvider: ProviderDef = {
      id: "pi-acp",
      label: "Pi ACP",
      status: "live",
      kind: "acp",
      caps: { canFollowUp: true, canCancel: true },
      models: [{ id: "pi-default", label: "Pi Default", isDefault: true }],
    };
    const { acpEndpoints } = buildAgentModelOptions(
      config,
      [piProvider],
      [
        {
          id: "pi-acp",
          label: "Pi ACP",
          command: "pi-acp",
          status: "available",
          installed: true,
          handshakeOk: true,
          selected: false,
          compatibility: "",
          models: [
            { id: "auto", label: "Auto" },
            { id: "gpt-5.4", label: "GPT-5.4" },
          ],
        },
      ],
    );

    expect(acpEndpoints).toEqual([
      { kind: "acp", providerId: "pi-acp", modelId: "auto", label: "Auto" },
      {
        kind: "acp",
        providerId: "pi-acp",
        modelId: "gpt-5.4",
        label: "GPT-5.4",
      },
    ]);
  });
});
