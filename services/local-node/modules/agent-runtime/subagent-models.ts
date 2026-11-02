import {
  getGlobalConfigForRuntime,
  getProjectConfigForRuntime,
} from "../../infrastructure/runtime/config/config-store.js";
import { getRuntimeCatalog } from "../../infrastructure/llm-runtime/catalog.js";
import { hasConfiguredApiKey } from "../../infrastructure/llm-runtime/pipeline.js";
import {
  isModelRefResolvable,
  mergeProviderConfig,
  resolveLlmSelection,
  resolveRuntimeProvider,
} from "../../infrastructure/llm-runtime/resolver.js";
import type { ResolveLlmSelectionInput } from "../../infrastructure/llm-runtime/types.js";
import { AgentValidationError } from "./runtime-errors.js";

/**
 * A delegated child runs on one of the models the user configured. The option
 * list is derived from configuration and verified against the same resolver a
 * real turn uses, so `profile.model` is never a value the model has to invent.
 */
export interface SubagentModelOption {
  /** Exact `providerId/modelId` value `profile.model` accepts. */
  ref: string;
  providerId: string;
  modelId: string;
  /** Display label for diagnostics, never parsed back into a ref. */
  label: string;
}

/** `thinkingMode` presets are reasoning effort; none of them is a model ID. */
export const SUBAGENT_THINKING_MODES = ["fast", "standard", "deep"] as const;

const MAX_LISTED_OPTIONS = 12;

/**
 * Every configured model a child turn can actually start on: an enabled API
 * provider, a connection that can authenticate, and a model the resolver
 * accepts. Anything else would only move the failure from guessing to running.
 */
export function listSubagentModelOptions(
  input: ResolveLlmSelectionInput,
): SubagentModelOption[] {
  const options: SubagentModelOption[] = [];
  const seen = new Set<string>();
  const add = (option: SubagentModelOption) => {
    if (seen.has(option.ref)) return;
    seen.add(option.ref);
    options.push(option);
  };

  for (const definition of input.globalConfig.providers) {
    if (definition.kind !== "api") continue;
    const provider = resolveRuntimeProvider(definition.id, input);
    if (!provider?.supported) continue;
    const config = mergeProviderConfig(
      definition.id,
      input.globalConfig.providerConnections[definition.id],
      input.projectConfig?.providerConnection?.providerId === definition.id
        ? input.projectConfig.providerConnection
        : undefined,
    );
    if (!hasConfiguredApiKey(config, provider.env)) continue;
    const models = [
      ...provider.models,
      // Per-model connection overrides are configured too, even when the
      // provider definition never listed them.
      ...Object.keys(config.models ?? {}).map((id) => ({ id, label: id })),
    ];
    for (const model of models) {
      const ref = `${definition.id}/${model.id}`;
      if (!isModelRefResolvable(input, ref)) continue;
      add({
        ref,
        providerId: definition.id,
        modelId: model.id,
        label: `${provider.label || definition.label} · ${model.label || model.id}`,
      });
    }
  }

  // A project can pin a model that is not in the provider's saved list; the
  // effective default leads the list so the option a plain inherit would use is
  // always visible and selectable.
  const fallback = resolveDefaultOption(input);
  if (fallback) {
    const existing = options.findIndex((option) => option.ref === fallback.ref);
    if (existing >= 0) options.splice(existing, 1);
    options.unshift(fallback);
  }
  return options;
}

function resolveDefaultOption(
  input: ResolveLlmSelectionInput,
): SubagentModelOption | null {
  try {
    const selection = resolveLlmSelection(input);
    if (!hasConfiguredApiKey(selection.config, selection.provider.env))
      return null;
    return {
      ref: selection.model,
      providerId: selection.providerId,
      modelId: selection.modelId,
      label: `${selection.provider.label || selection.providerId} · ${
        selection.modelDef.label || selection.modelId
      }`,
    };
  } catch {
    // Nothing usable is configured; the enumerated options stand alone.
    return null;
  }
}

/** Exact refs win; a bare model ID is accepted only when it is unambiguous. */
export function matchSubagentModelOption(
  options: readonly SubagentModelOption[],
  requested: string,
): SubagentModelOption | null {
  const value = requested.trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  const exact = options.find(
    (option) => option.ref.toLowerCase() === lower,
  );
  if (exact) return exact;
  if (value.includes("/")) return null;
  const byModelId = options.filter(
    (option) => option.modelId.toLowerCase() === lower,
  );
  return byModelId.length === 1 ? byModelId[0]! : null;
}

function formatOptions(options: readonly SubagentModelOption[]): string {
  const listed = options
    .slice(0, MAX_LISTED_OPTIONS)
    .map((option) => option.ref)
    .join(", ");
  const rest = options.length - MAX_LISTED_OPTIONS;
  return rest > 0 ? `${listed} (+${rest} more)` : listed;
}

function isThinkingMode(value: string): boolean {
  return (SUBAGENT_THINKING_MODES as readonly string[]).includes(
    value.toLowerCase(),
  );
}

/** Actionable rejection: state the exact accepted values, never a guess. */
export function subagentModelError(
  requested: string,
  options: readonly SubagentModelOption[],
  context: { templateName?: string } = {},
): AgentValidationError {
  const value = requested.trim();
  const configured = options.length
    ? ` Configured model refs: ${formatOptions(options)}.`
    : "";
  if (isThinkingMode(value))
    return new AgentValidationError(
      `profile.model '${value}' is a thinking mode, not a model. Set profile.thinkingMode to ${
        SUBAGENT_THINKING_MODES.join("/")
      } and omit profile.model to inherit the parent's model.${configured}`,
    );
  if (context.templateName)
    return new AgentValidationError(
      `Custom subagent '${context.templateName}' requests model '${value}', which is not configured. Update it in Settings > Subagents, or save it without a model to inherit the parent's.${configured}`,
    );
  return new AgentValidationError(
    options.length
      ? `'${value}' is not a configured model. Use an exact ref from: ${formatOptions(
          options,
        )} — or omit profile.model to inherit the parent's model.`
      : `'${value}' is not a configured model, and no chat model is configured yet. Omit profile.model to inherit the parent's model, and configure a provider in Settings.`,
  );
}

/** Deterministic text appended to the delegation tool definitions. */
export function describeSubagentModelOptions(
  options: readonly SubagentModelOption[],
): string {
  if (!options.length)
    return "profile.model must be omitted: no chat model is configured, so a child inherits the parent's model.";
  return `profile.model accepts only these configured refs: ${formatOptions(
    options,
  )}. Omit it to inherit the parent's model; profile.thinkingMode (${
    SUBAGENT_THINKING_MODES.join("/")
  }) changes reasoning effort, not the model.`;
}

async function selectionInput(
  projectId: string | null | undefined,
): Promise<ResolveLlmSelectionInput> {
  const catalog = await getRuntimeCatalog();
  return {
    catalog,
    globalConfig: getGlobalConfigForRuntime(),
    projectConfig: projectId ? getProjectConfigForRuntime(projectId) : null,
    purpose: "agent",
  };
}

export async function subagentModelOptions(
  projectId: string | null | undefined,
): Promise<SubagentModelOption[]> {
  return listSubagentModelOptions(await selectionInput(projectId));
}

export async function subagentModelGuidance(
  projectId: string | null | undefined,
): Promise<string> {
  return describeSubagentModelOptions(await subagentModelOptions(projectId));
}

/**
 * Normalize (or reject) a requested child model before the child exists, so a
 * bad value is a fixable tool error instead of a failed subtask.
 */
export async function resolveRequestedSubagentModel(
  projectId: string | null | undefined,
  requested: string | undefined,
  context: { templateName?: string } = {},
): Promise<string | undefined> {
  const value = requested?.trim();
  if (!value) return undefined;
  const options = await subagentModelOptions(projectId);
  const match = matchSubagentModelOption(options, value);
  if (!match) throw subagentModelError(value, options, context);
  return match.ref;
}
