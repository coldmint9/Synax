import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import type {
  ResolvedModelSelection,
  LlmGatewayMessage,
} from "../llm-runtime/types.js";
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
const caps = (
  modalities?: InputModality[],
  mediaTypes?: string[],
  maxFileBytes = MAX_FILE_BYTES,
  maxTotalBytes = MAX_INPUT_BYTES,
): InputCapabilities => ({
  modalities: modalities ?? ["text"],
  verified: !!modalities,
  mediaTypes,
  maxFileBytes,
  maxTotalBytes,
  maxFiles: 10,
});
export function nativeInputCapabilities(
  selection: ResolvedModelSelection,
): InputCapabilities {
  const declared = selection.modelDef.inputModalities;
  const npm = selection.provider.npm;
  // A model catalog alone cannot prove that an SDK preserves media on the wire.
  if (
    ![
      "@ai-sdk/openai",
      "@ai-sdk/openai-compatible",
      "@ai-sdk/anthropic",
      "@ai-sdk/google",
    ].includes(npm ?? "")
  )
    return caps(undefined);
  if (npm === "@ai-sdk/google")
    return caps(
      declared,
      [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "application/pdf",
        "text/plain",
        "audio/*",
        "video/*",
      ],
      20 * 1024 * 1024,
      20 * 1024 * 1024,
    );
  if (selection.apiFormat === "anthropic" || npm === "@ai-sdk/anthropic")
    return caps(
      declared,
      [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "application/pdf",
        "text/plain",
      ],
      5 * 1024 * 1024,
      24 * 1024 * 1024,
    );
  if (selection.apiFormat === "openai-responses")
    return caps(
      declared,
      [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "application/pdf",
        "text/plain",
        "text/csv",
        "application/json",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ],
      MAX_FILE_BYTES,
      MAX_FILE_BYTES,
    );
  // The installed Chat adapter has native image, PDF and WAV/MP3 parts.
  if (selection.apiFormat === "openai")
    return caps(declared, [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "application/pdf",
      ...(["@ai-sdk/openai", "@ai-sdk/openai-compatible"].includes(npm ?? "")
        ? ["audio/wav", "audio/mpeg"]
        : []),
    ]);
  return caps(undefined);
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
      await import("../llm-runtime/gateway.js");
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
  const parts = inputParts(input);
  validateAssets(parts, session.projectId);
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
    ...referencedAssets(history, session.projectId),
  ];
  const unique = [...new Map(assets.map((a) => [a.id, a])).values()];
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
      await import("../llm-runtime/gateway.js");
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
