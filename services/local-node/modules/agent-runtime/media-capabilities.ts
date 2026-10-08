import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import type {
  ResolvedModelSelection,
  LlmGatewayMessage,
} from "../../infrastructure/llm-runtime/types.js";
import {
  MAX_FILE_BYTES,
  MAX_INPUT_BYTES,
  inputParts,
  modalityForMime,
  type InputCapabilities,
  type InputModality,
  type RuntimeContentPart,
  type RuntimeAsset,
} from "./content-parts.js";
import { getAsset, readAsset, validateAssets } from "./media-assets.js";
import { AgentRuntimeError } from "./runtime-errors.js";
import type { StreamTurnRequest } from "./contracts.js";
import { resolveMediaProfile } from "../../infrastructure/llm-runtime/providers/media-profile.js";
import { parseAssetInput, resolveFileParts } from "./file-input/index.js";
import { isNativeVisual } from "./file-input/registry.js";
/**
 * Media input stays blocked while no layer declares the model's modalities, so
 * the message must name the action that works for every adapter.
 */
export const UNDECLARED_MODALITIES_REASON =
  "输入模态未确认，请在设置声明或选择兼容模型 / Input modalities unconfirmed";
const caps = (
  modalities?: InputModality[],
  mediaTypes?: string[],
  maxFileBytes = MAX_FILE_BYTES,
  maxTotalBytes = MAX_INPUT_BYTES,
  maxFiles = 10,
): InputCapabilities => ({
  modalities: modalities ?? ["text"],
  verified: !!modalities,
  status: modalities ? "verified" : "undeclared",
  ...(modalities ? {} : { reason: UNDECLARED_MODALITIES_REASON }),
  mediaTypes,
  maxFileBytes,
  maxTotalBytes,
  maxFiles,
});
export function nativeInputCapabilities(
  selection: ResolvedModelSelection,
): InputCapabilities {
  const declared = selection.modelDef.inputModalities;
  const profile = resolveMediaProfile({
    npm: selection.provider.npm,
    apiFormat: selection.apiFormat,
    providerId: selection.providerId,
    modelId: selection.modelId,
    baseUrl: selection.config.baseUrl ?? selection.provider.api,
  });
  // A declaration is what makes media reachable: neither the model catalog nor
  // the adapter alone proves the model accepts media. The profile then narrows
  // the declaration to what this connection can actually carry.
  const usable = declared?.length
    ? [
        ...new Set<InputModality>([
          "text",
          ...declared.filter(
            (modality) =>
              (modality === "text" || modality === "image" || modality === "video") &&
              (modality === "text" || !profile.carriers || profile.carriers.includes(modality)),
          ),
        ]),
      ]
    : undefined;
  return {
    modalities: usable ?? ["text"],
    verified: Boolean(usable),
    status: usable
      ? profile.carriers
        ? "verified"
        : "declared"
      : "undeclared",
    ...(usable ? {} : { reason: UNDECLARED_MODALITIES_REASON }),
    ...(profile.mediaTypes ? { mediaTypes: profile.mediaTypes.filter(isNativeVisual) } : {}),
    maxFileBytes: profile.limits.maxFileBytes ?? MAX_FILE_BYTES,
    maxTotalBytes: profile.limits.maxTotalBytes ?? MAX_INPUT_BYTES,
    maxFiles: profile.limits.maxFiles ?? 10,
  };
}

export function assertMediaCapabilities(
  assets: RuntimeAsset[],
  capability: InputCapabilities,
): void {
  if (!assets.length) return;
  if (!capability.verified)
    throw new AgentRuntimeError(
      "Input modalities are unconfirmed. Declare the model capabilities or select a verified model.",
      "MEDIA_CAPABILITY_UNKNOWN",
      422,
    );
  if (
    assets.length > capability.maxFiles ||
    assets.some((a) => a.size > capability.maxFileBytes) ||
    assets.reduce((s, a) => s + a.size, 0) > capability.maxTotalBytes
  )
    throw new AgentRuntimeError(
      "Attachments exceed the selected backend file/request limits.",
      "MEDIA_TOO_LARGE",
      413,
    );
  for (const a of assets) {
    const matches = (pattern: string) =>
      pattern.endsWith("/*")
        ? a.mediaType.startsWith(pattern.slice(0, -1))
        : a.mediaType === pattern;
    if (
      !capability.modalities.includes(modalityForMime(a.mediaType)) ||
      (capability.mediaTypes && !capability.mediaTypes.some(matches))
    )
      throw new AgentRuntimeError(
        `The selected model/protocol cannot receive ${a.filename} (${a.mediaType}). Select a compatible model or remove it.`,
        "UNSUPPORTED_MEDIA",
        422,
      );
  }
}
export async function sessionInputCapabilities(
  sessionId: string,
  model?: string,
): Promise<InputCapabilities> {
  const { agentRuntimeStore: store } = await import("./session-store.js");
  const { resolveSessionBackend, resolveBackendModel } =
    await import("./backends/backend-binding.js");
  const session = store.getSession(sessionId),
    binding = resolveSessionBackend(sessionId);
  if (binding.id === "native") {
    const { resolveGatewaySelection } =
      await import("../../infrastructure/llm-runtime/gateway.js");
    return nativeInputCapabilities(
      await resolveGatewaySelection({
        projectId: session.projectId,
        purpose: "agent",
        model: resolveBackendModel(sessionId, { model }) ?? undefined,
      }),
    );
  }
  if (binding.id === "codex") {
    const { codexBackend } = await import("./backends/codex-backend.js");
    const result = await codexBackend.models();
    const selected = model ?? binding.model ?? result.defaultModel;
    const m =
      selected && selected !== "default"
        ? result.models.find((m) => m.id === selected)
        : result.models[0];
    return caps(m?.inputModalities, [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]);
  }
  if (binding.id === "claude-code")
    return caps(
      ["text", "image"],
      ["image/png", "image/jpeg", "image/webp", "image/gif"],
      5 * 1024 * 1024,
      24 * 1024 * 1024,
    );
  const { acpConnectionPool } =
    await import("./acp-engine/acp-connection-pool.js");
  const connection = await acpConnectionPool.acquire({
    synaxSessionId: sessionId,
    projectId: session.projectId,
    providerId: binding.id,
  });
  const prompt = connection.capabilities.promptCapabilities;
  return caps(
    [
      "text",
      ...(prompt?.image ? ["image" as const] : []),
      ...(prompt?.audio ? ["audio" as const] : []),
      ...(prompt?.embeddedContext ? ["file" as const] : []),
    ],
    [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "audio/*",
      "application/pdf",
      "text/plain",
    ],
  );
}
export async function validateInputMedia(
  sessionId: string,
  input: StreamTurnRequest,
): Promise<void> {
  const { agentRuntimeStore: store } = await import("./session-store.js");
  const session = store.getSession(sessionId);
  validateAssets(inputParts(input), session.projectId);
  const parts = await resolveFileParts(inputParts(input), session.projectId);
  if (!parts.some((p) => p.type !== "text") && !input.model) return;
  const { buildLoopModelMessages } = await import("./loop-model-messages.js");
  const { workStore } = await import("./work-store.js");
  const work = workStore.current(sessionId);
  const runs = store
    .listRuns(sessionId)
    .filter(
      (r) =>
        !work ||
        r.metadata.workId === work.id ||
        store.listRunSteps(r.id).some((s) => s.metadata.workId === work.id),
    )
    .sort(
      (a, b) =>
        a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
    );
  const steps = runs.flatMap((r) => store.listRunSteps(r.id));
  const boundary = work?.checkpoint
    ? steps.findIndex((s) => s.id === work.checkpoint!.throughStepId)
    : -1;
  const excludedStepIds = new Set(
    steps
      .filter(
        (s, index) =>
          index <= boundary ||
          (work &&
            (s.metadata.workId ?? store.getRun(s.runId).metadata.workId) !==
              work.id),
      )
      .map((s) => s.id),
  );
  const history = buildLoopModelMessages(
    store,
    sessionId,
    { resolveModelToolName: () => null },
    { workId: work?.id, excludedStepIds },
  );
  const assets = [
    ...parts
      .filter((p) => p.type !== "text")
      .map((p) => getAsset(p.assetId, session.projectId)),
    ...referencedAssets(
      history.filter(
        (message) =>
          message.role !== "assistant" &&
          !(
            message.role === "user" &&
            message.providerOptions?.synax?.toolCallId
          ),
      ),
      session.projectId,
    ),
  ];
  for (const asset of assets)
    if (!isNativeVisual(asset.mediaType)) await parseAssetInput(asset);
  const unique = [...new Map(assets.filter((asset) => isNativeVisual(asset.mediaType)).map((a) => [a.id, a])).values()];
  if (unique.length)
    assertMediaCapabilities(
      unique,
      await sessionInputCapabilities(sessionId, input.model),
    );
}
function assetId(data: unknown): string | undefined {
  const text =
    data instanceof URL ? data.href : typeof data === "string" ? data : "";
  return text.startsWith("synax-asset:") ? text.slice(12) : undefined;
}
function referencedAssets(
  messages: LlmGatewayMessage[],
  projectId?: string,
): RuntimeAsset[] {
  const found: RuntimeAsset[] = [];
  for (const message of messages)
    if (Array.isArray(message.content))
      for (const p of message.content) {
        if (p.type === "file") {
          const id = assetId(p.data);
          if (id) found.push(getAsset(id, projectId));
        }
      }
  return found;
}
export async function resolveMediaMessages(
  messages: LlmGatewayMessage[],
  selection: ResolvedModelSelection,
  projectId?: string,
): Promise<LlmGatewayMessage[]> {
  if (!projectId && referencedAssets(messages).length)
    throw new AgentRuntimeError("Media requires a project context.", "MEDIA_PROJECT_REQUIRED", 400);
  // Documents, including historical asset references, become text before any
  // provider-specific MIME or modality checks. Their bytes never reach the API.
  const parsedAssets = new Map<string, string>();
  messages = await Promise.all(messages.map(async (message) => {
    if (!Array.isArray(message.content)) return message;
    const content = await Promise.all(message.content.map(async (part) => {
      if (part.type !== "file") return part;
      const id = assetId(part.data);
      if (!id) {
        if (isNativeVisual(part.mediaType)) return part;
        throw new AgentRuntimeError("Document input requires a local asset reference; use a file parsing tool first.", "UNSUPPORTED_FILE", 422);
      }
      const asset = getAsset(id, projectId);
      if (isNativeVisual(asset.mediaType)) return part;
      let text = parsedAssets.get(id);
      if (text === undefined) {
        try {
          text = (await parseAssetInput(asset)).text;
        } catch (error) {
          if (!(error instanceof AgentRuntimeError) ||
            !(message.role === "assistant" || message.providerOptions?.synax?.toolCallId || message.providerOptions?.synax?.generatedMedia)) throw error;
          text = `Binary asset retained for download or a parsing tool: ${JSON.stringify(asset)}. ${error.message}`;
        }
        parsedAssets.set(id, text);
      }
      return { type: "text" as const, text };
    }));
    return { ...message, content } as LlmGatewayMessage;
  }));
  const capability = nativeInputCapabilities(selection);
  // Google accepts native assistant media (including thought signatures).
  // Chat/Responses/Anthropic accept prior generated files as explicit context.
  if (selection.provider.npm !== "@ai-sdk/google")
    messages = messages.flatMap((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.content))
        return [message];
      const files = message.content.filter((part) => part.type === "file");
      if (!files.length) return [message];
      const text = message.content.filter((part) => part.type !== "file");
      return [
        ...(text.length ? [{ ...message, content: text }] : []),
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: "Previously generated assistant media, retained as context; this is not a new user request.",
            },
            ...files,
          ],
          providerOptions: { synax: { generatedMedia: true } },
        },
      ];
    });
  messages = messages.map((message) => {
    if (
      message.role !== "user" ||
      !(
        message.providerOptions?.synax?.toolCallId ||
        message.providerOptions?.synax?.generatedMedia
      ) ||
      !Array.isArray(message.content)
    )
      return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "file") return part;
        const id = assetId(part.data);
        if (!id) return part;
        const asset = getAsset(id, projectId);
        try {
          assertMediaCapabilities([asset], capability);
          return part;
        } catch (error) {
          if (!(error instanceof AgentRuntimeError)) throw error;
          return {
            type: "text" as const,
            text: `Media asset retained: ${JSON.stringify(asset)}. This model cannot receive these bytes (${error.message}). Use a compatible media tool or model to inspect it.`,
          };
        }
      }),
    };
  });
  const assets = referencedAssets(messages, projectId);
  if (!assets.length) return messages;
  if (!projectId)
    throw new AgentRuntimeError(
      "Media requires a project context.",
      "MEDIA_PROJECT_REQUIRED",
      400,
    );
  assertMediaCapabilities(
    [...new Map(assets.map((a) => [a.id, a])).values()],
    nativeInputCapabilities(selection),
  );
  const cache = new Map<string, Buffer>();
  for (const asset of assets)
    if (!cache.has(asset.id))
      cache.set(asset.id, await readAsset(asset.id, projectId));
  const hydrated = messages.map((message) =>
    typeof message.content === "string"
      ? message
      : ({
          ...message,
          content: message.content.map((p) => {
            if (p.type === "file") {
              const id = assetId(p.data);
              if (id) return { ...p, data: cache.get(id)! };
            }
            return p;
          }),
        } as LlmGatewayMessage),
  );
  if (
    selection.apiFormat === "openai" &&
    selection.provider.npm !== "@ai-sdk/google"
  )
    return hydrated;
  const compiled: LlmGatewayMessage[] = [];
  for (const message of hydrated) {
    const callId =
      message.role === "user"
        ? message.providerOptions?.synax?.toolCallId
        : undefined;
    const previous = compiled.at(-1);
    if (
      typeof callId !== "string" ||
      message.role !== "user" ||
      !Array.isArray(message.content) ||
      previous?.role !== "tool" ||
      !message.content.every(
        (p) =>
          p.type === "text" ||
          (p.type === "file" && p.data instanceof Uint8Array),
      )
    ) {
      compiled.push(message);
      continue;
    }
    const target = previous.content.find(
      (p) => p.type === "tool-result" && p.toolCallId === callId,
    );
    if (
      !target ||
      target.type !== "tool-result" ||
      !["text", "json", "content"].includes(target.output.type)
    ) {
      compiled.push(message);
      continue;
    }
    const value: Extract<ToolResultOutput, { type: "content" }>["value"] = [];
    for (const part of message.content) {
      if (part.type === "text") value.push({ type: "text", text: part.text });
      else if (part.type === "file")
        value.push({
          type: "file",
          mediaType: part.mediaType,
          filename: part.filename,
          ...(part.providerOptions
            ? { providerOptions: part.providerOptions }
            : {}),
          data: {
            type: "data",
            data: Buffer.from(part.data as Uint8Array).toString("base64"),
          },
        });
    }
    const existing = "value" in target.output ? target.output.value : "";
    compiled[compiled.length - 1] = {
      ...previous,
      content: previous.content.map((p) =>
        p === target
          ? {
              ...p,
              output: {
                type: "content" as const,
                value: [
                  {
                    type: "text" as const,
                    text:
                      typeof existing === "string"
                        ? existing
                        : JSON.stringify(existing),
                  },
                  ...value,
                ],
              },
            }
          : p,
      ),
    };
  }
  return compiled;
}
export async function draftInputCapabilities(
  projectId: string,
  backendId: string,
  model?: string,
): Promise<InputCapabilities> {
  if (backendId === "native") {
    const { resolveGatewaySelection } =
      await import("../../infrastructure/llm-runtime/gateway.js");
    return nativeInputCapabilities(
      await resolveGatewaySelection({ projectId, purpose: "agent", model }),
    );
  }
  if (backendId === "claude-code")
    return caps(
      ["text", "image"],
      ["image/png", "image/jpeg", "image/webp", "image/gif"],
      5 * 1024 * 1024,
      24 * 1024 * 1024,
    );
  if (backendId === "codex") {
    const { codexBackend } = await import("./backends/codex-backend.js");
    const result = await codexBackend.models();
    const requested = model ?? result.defaultModel;
    const selected =
      requested && requested !== "default"
        ? result.models.find((m) => m.id === requested)
        : result.models[0];
    return caps(selected?.inputModalities, [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]);
  }
  return caps(undefined);
}
