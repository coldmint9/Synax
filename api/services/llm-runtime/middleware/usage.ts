import { wrapLanguageModel } from "ai";
import type { JSONObject, LanguageModelV4 } from "@ai-sdk/provider";
import {
  mergeRawUsage,
  whitelistRawUsage,
  type UsageContext,
} from "../usage.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
/** One accumulator per doStream/doGenerate attempt, never shared between requests. */
export function applyUsageMiddleware(
  model: LanguageModelV4,
  context: UsageContext = {},
): LanguageModelV4 {
  const metadata = (existing: unknown, raw: unknown) =>
    ({
      ...record(existing),
      synaxUsage: {
        version: 1,
        source: "sdk",
        ...(context.protocol ? { protocol: context.protocol } : {}),
        adapter: context.adapter ?? model.provider,
        raw: whitelistRawUsage(raw),
      },
    }) as Record<string, JSONObject>;
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: async ({ params }) => ({
        ...params,
        includeRawChunks: true,
      }),
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        const body = record(result.response?.body);
        // response.body is the unparsed provider JSON; usage.raw may be schema-stripped.
        const raw =
          result.response?.body !== undefined ? body.usage : result.usage.raw;
        return {
          ...result,
          usage: { ...result.usage, raw: whitelistRawUsage(raw) as JSONObject },
          providerMetadata: metadata(result.providerMetadata, raw),
        };
      },
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        let raw: Record<string, unknown> = {};
        let sawRawPart = false;
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                if (part.type === "raw") {
                  sawRawPart = true;
                  const payload = record(part.rawValue);
                  const candidate =
                    payload.usage ??
                    record(payload.message).usage ??
                    record(payload.response).usage;
                  if (candidate !== undefined && candidate !== null) {
                    raw = mergeRawUsage(raw, candidate);
                  }
                }
                if (part.type === "finish") {
                  const evidence = sawRawPart
                    ? raw
                    : whitelistRawUsage(part.usage.raw);
                  controller.enqueue({
                    ...part,
                    usage: { ...part.usage, raw: evidence as JSONObject },
                    providerMetadata: metadata(part.providerMetadata, evidence),
                  });
                } else controller.enqueue(part);
              },
            }),
          ),
        };
      },
    },
  });
}
