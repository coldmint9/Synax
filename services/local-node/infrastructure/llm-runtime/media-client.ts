import { nativeEvents } from "./native-client.js";
import type { ResolvedProviderConfig, RuntimeProvider } from "./types.js";

export interface MediaFile { data: string; mediaType: string; filename?: string; format?: string; revisedPrompt?: string }
export interface NativeMediaResult {
  files?: MediaFile[];
  text?: string;
  language?: string;
  segments?: unknown[];
  durationInSeconds?: number;
  usage?: Record<string, unknown>;
  warnings?: unknown[];
}
export async function requestMedia(
  selection: { provider: Pick<RuntimeProvider, "id" | "api" | "env" | "npm">; config: ResolvedProviderConfig; modelId?: string },
  operation: "images" | "speech" | "transcribe" | "video",
  options: Record<string, unknown>,
  input: { files?: MediaFile[]; mask?: MediaFile; signal?: AbortSignal; onPartial?: (file: MediaFile) => Promise<void> } = {},
): Promise<NativeMediaResult> {
  const settings = selection.config.options ?? {};
  const headers = { ...(settings.headers as Record<string, string> | undefined) };
  if (typeof settings.organization === "string") headers["OpenAI-Organization"] = settings.organization;
  if (typeof settings.project === "string") headers["OpenAI-Project"] = settings.project;
  const request = {
    operation, providerId: selection.provider.id, adapter: selection.provider.npm,
    baseUrl: settings.baseURL ?? selection.config.baseUrl ?? selection.provider.api,
    apiKey: settings.apiKey ?? selection.config.apiKey ?? selection.provider.env.map(name => process.env[name]).find(Boolean),
    headers, model: options.model, conversationModel: selection.modelId,
    options, files: input.files, mask: input.mask,
  };
  let result: NativeMediaResult | undefined;
  for await (const event of nativeEvents<{ type: string; file?: MediaFile } & NativeMediaResult>("/media/stream", request, input.signal)) {
    if (event.type === "media-partial" && event.file) await input.onPartial?.(event.file);
    if (event.type === "media-result") result = event;
  }
  if (!result) throw new Error("Native media stream ended without a result.");
  return result;
}
