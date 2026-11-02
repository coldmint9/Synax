import { getGlobalConfig } from "../../infrastructure/runtime/config/config-store.js";
import { AgentRuntimeError } from "./runtime-errors.js";

export interface InputAssistSelection {
  /** Model reference (`provider/model`) currently chosen in the composer. */
  model?: string;
  backendId?: string;
}

/**
 * Resolve the auxiliary model used by input-assist calls (draft rewrite and
 * next-input suggestion).
 *
 * The configured input-optimization model always wins, so both features stay on
 * the cheap/fast model the user picked for typing assistance instead of the
 * conversation model. Without a configured model the composer's own API model
 * is used; non-API backends cannot serve these isolated, tool-free calls.
 */
export function resolveInputAssistModel(selection: InputAssistSelection): string {
  const config = getGlobalConfig();
  const configured = config.inputOptimizationModel?.trim();
  const model = configured || selection.model?.trim();
  const separator = model?.indexOf("/") ?? -1;
  const provider = config.providers.find(
    (item) => item.id === model?.slice(0, separator),
  );
  if (
    !model ||
    (!configured && selection.backendId && selection.backendId !== "native") ||
    separator <= 0 ||
    separator === model.length - 1 ||
    (!configured && (!provider || provider.kind !== "api"))
  )
    throw new AgentRuntimeError(
      "请在设置中选择输入优化 API 模型，或在输入框选择 API 模型 / Select an input optimization API model in Settings or an API model in the composer.",
      "INPUT_OPTIMIZATION_MODEL_UNAVAILABLE",
      422,
    );
  return model;
}
