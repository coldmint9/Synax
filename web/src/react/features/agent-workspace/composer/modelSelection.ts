import type {
  AcpDiscoveryItem,
  GlobalConfig,
  ProviderDef,
} from "../../../../lib/contracts/config";
import {
  buildApiDrafts,
  isConfiguredProvider,
} from "../../settings/lib/providerPresets";

export type AgentModelSelection = {
  kind: "api" | "acp";
  providerId: string;
  modelId: string;
  label: string;
};

export function selectionKey(
  sel: Pick<AgentModelSelection, "kind" | "providerId" | "modelId">,
): string {
  return `${sel.kind}:${sel.providerId}:${sel.modelId}`;
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
    const drafts = buildApiDrafts(globalConfig, providers).filter(
      isConfiguredProvider,
    );
    for (const draft of drafts) {
      for (const modelId of draft.models) {
        apiModels.push({
          kind: "api",
          providerId: draft.id,
          modelId,
          label: modelId,
        });
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
): AgentModelSelection | null {
  if (!providerId || !modelId) return null;
  return (
    apiModels.find(
      (m) => m.providerId === providerId && m.modelId === modelId,
    ) ??
    acpEndpoints.find(
      (m) => m.providerId === providerId && m.modelId === modelId,
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
    if (found) return found;
  }
  return apiModels[0] ?? acpEndpoints[0] ?? null;
}
