import { prepareProvider } from "../local-node/infrastructure/llm-runtime/native-client.js";
import type { LlmGatewayRequest, ResolvedModelSelection } from "../local-node/infrastructure/llm-runtime/types.js";

export async function buildProtocolProviderOptions(selection: ResolvedModelSelection, request: Pick<LlmGatewayRequest, "reasoningEffort" | "responseOptions">) {
  const prepared = await prepareProvider({ apiFormat: selection.apiFormat, providerId: selection.providerId,
    model: selection.modelId, prompt: [], reasoningCapable: selection.modelDef.reasoning,
    reasoningEffort: request.reasoningEffort, responseOptions: request.responseOptions as Record<string, unknown> });
  return prepared.providerOptions;
}
