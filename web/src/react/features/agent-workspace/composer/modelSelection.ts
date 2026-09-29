import type {
  AcpDiscoveryItem,
  GlobalConfig,
  ProviderDef,
  ProviderModelDef,
} from "../../../../lib/contracts/config";
import type { ModelCapability } from "../../../../lib/contracts/media-generation";
import {
  buildApiDrafts,
  isConfiguredProvider,
} from "../../settings/lib/providerPresets";

export type AgentModelSelection = {
  kind: "api" | "acp";
  providerId: string;
  modelId: string;
  label: string;
  capability: ModelCapability;
};

export function selectionKey(
  sel: Pick<AgentModelSelection, "kind" | "providerId" | "modelId" | "capability">,
): string {
  return `${sel.kind}:${sel.providerId}:${sel.modelId}:${sel.capability}`;
}

function modelCapabilities(model: ProviderModelDef): ModelCapability[] {
  if (model.capabilities) return model.capabilities;
  const inferred: ModelCapability[] = [];
  const operations = model.media?.operations ?? [];
  if (operations.some((operation) => operation.endsWith("image"))) {
    inferred.push("image_generation");
  }
  if (operations.some((operation) => operation.endsWith("video"))) {
    inferred.push("video_generation");
  }
  if (inferred.length === 0) inferred.push("chat");
  return inferred;
}

/** Preserve the selected provider for both API models and ACP engines. */
export function formatModelReference(
  providerId: string | null,
  modelId: string | null,
): string | undefined {
  if (!modelId?.trim()) return undefined;
  const model = modelId.trim();
  if (providerId) {
    return model.startsWith(`${providerId}/`)
      ? model
      : `${providerId}/${model}`;
  }
  return model;
}

export function discoveredAcpProviders(
  providers: ProviderDef[],
  discovery: AcpDiscoveryItem[],
): ProviderDef[] {
  const availableIds = new Set(
    discovery
      .filter(
        (item) =>
          item.status === "available" && item.installed && item.handshakeOk,
      )
      .map((item) => item.id),
  );
  return providers.filter(
    (provider) =>
      provider.kind === "acp" &&
      provider.status !== "inactive" &&
      availableIds.has(provider.id),
  );
}

export function buildAgentModelOptions(
  globalConfig: GlobalConfig | null,
  providers: ProviderDef[],
  acpDiscovery: AcpDiscoveryItem[] = [],
): { apiModels: AgentModelSelection[]; acpEndpoints: AgentModelSelection[] } {
  const apiModels: AgentModelSelection[] = [];
  const acpEndpoints: AgentModelSelection[] = [];

  if (globalConfig) {
    const configuredIds = new Set(buildApiDrafts(globalConfig, providers).filter(
      isConfiguredProvider,
    ).map((draft) => draft.id));
    for (const provider of providers.filter(
      (item) => item.kind === "api" && item.status !== "inactive" && configuredIds.has(item.id),
    )) {
      for (const model of provider.models) {
        for (const capability of modelCapabilities(model)) {
          apiModels.push({
            kind: "api",
            providerId: provider.id,
            modelId: model.id,
            label: model.label || model.id,
            capability,
          });
        }
      }
    }
  }

  const discoveryById = new Map(acpDiscovery.map((item) => [item.id, item]));

  for (const provider of discoveredAcpProviders(providers, acpDiscovery)) {
    const discoveryItem = discoveryById.get(provider.id);
    const catalogModels = discoveryItem?.models ?? [];
    if (catalogModels.length > 0) {
      for (const model of catalogModels) {
        acpEndpoints.push({
          kind: "acp",
          providerId: provider.id,
          modelId: model.id,
          label: model.label,
          capability: "chat",
        });
      }
      continue;
    }

    for (const model of provider.models) {
      acpEndpoints.push({
        kind: "acp",
        providerId: provider.id,
        modelId: model.id,
        label: model.label || provider.label,
        capability: "chat",
      });
    }
  }

  return { apiModels, acpEndpoints };
}

export function findAgentModelSelection(
  apiModels: AgentModelSelection[],
  acpEndpoints: AgentModelSelection[],
  providerId: string | null,
  modelId: string | null,
  capability?: ModelCapability | null,
): AgentModelSelection | null {
  if (!providerId || !modelId) return null;
  return (
    apiModels.find(
      (m) =>
        m.providerId === providerId &&
        m.modelId === modelId &&
        (!capability || m.capability === capability),
    ) ??
    acpEndpoints.find(
      (m) =>
        m.providerId === providerId &&
        m.modelId === modelId &&
        (!capability || m.capability === capability),
    ) ??
    null
  );
}

export function pickDefaultModelSelection(
  apiModels: AgentModelSelection[],
  acpEndpoints: AgentModelSelection[],
  preferred?: { providerId: string; modelId: string } | null,
): AgentModelSelection | null {
  if (preferred) {
    const found = findAgentModelSelection(
      apiModels,
      acpEndpoints,
      preferred.providerId,
      preferred.modelId,
    );
    if (found?.capability === "chat") return found;
  }
  return apiModels.find((model) => model.capability === "chat") ?? acpEndpoints[0] ?? apiModels[0] ?? null;
}
