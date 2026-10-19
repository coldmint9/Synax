import type {
  GlobalConfig,
  ProviderDef,
  ProviderModelDef,
} from "../../../shared/contracts/config";
import type { ModelCapability } from "../../../shared/contracts/media-generation";
import {
  buildApiDrafts,
  isConfiguredProvider,
} from "../../settings/lib/providerPresets";

export type AgentModelSelection = {
  kind: "api";
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

/** Preserve the selected API provider and avoid duplicating its prefix. */
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

export function buildAgentModelOptions(
  globalConfig: GlobalConfig | null,
  providers: ProviderDef[],
): { apiModels: AgentModelSelection[] } {
  const apiModels: AgentModelSelection[] = [];

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

  return { apiModels };
}

export function findAgentModelSelection(
  apiModels: AgentModelSelection[],
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
    null
  );
}

export function pickDefaultModelSelection(
  apiModels: AgentModelSelection[],
  preferred?: { providerId: string; modelId: string } | null,
): AgentModelSelection | null {
  if (preferred) {
    const found = findAgentModelSelection(
      apiModels,
      preferred.providerId,
      preferred.modelId,
    );
    if (found?.capability === "chat") return found;
  }
  return apiModels.find((model) => model.capability === "chat") ?? apiModels[0] ?? null;
}
