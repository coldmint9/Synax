import { wrapLanguageModel } from "ai";
import type { JSONObject, LanguageModelV4 } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { currentExecutionContext } from "../../../lib/execution-context.js";
import { logger } from "../../../lib/logger.js";
import {
  extendedUsageObject,
  extractExtendedUsage,
  mergeExtendedUsage,
  observeProviderMetrics,
  type MetricScalar,
} from "../../provider-metrics.js";
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
  const metadata = (
    existing: unknown,
    raw: unknown,
    extensions: Record<string, MetricScalar>,
    requestId: string,
  ) =>
    ({
      ...record(existing),
      synaxUsage: {
        version: 1,
        source: "sdk",
        ...(context.protocol ? { protocol: context.protocol } : {}),
        adapter: context.adapter ?? model.provider,
        raw: whitelistRawUsage(raw),
        extensions,
        requestId,
      },
    }) as Record<string, JSONObject>;
  const capture = (
    extensions: Record<string, MetricScalar>,
    requestId: string,
  ) => {
    if (!context.providerId) return;
    try {
      observeProviderMetrics({
        providerId: context.providerId,
        sessionId: context.sessionId ?? currentExecutionContext()?.sessionId,
        requestId,
        values: extensions,
      });
    } catch (error) {
      // Telemetry storage must never turn an otherwise successful model call into a retry.
      logger.warn(
        {
          error:
            error instanceof Error
              ? error.message
              : "Metric persistence failed",
        },
        "[provider-metrics] could not record usage",
      );
    }
  };
  const completeRaw = (
    raw: unknown,
    extensions: Record<string, MetricScalar>,
  ) => {
    const standard = whitelistRawUsage(raw);
    for (const [key, value] of Object.entries(
      extendedUsageObject(extensions),
    )) {
      standard[key] =
        value !== null && typeof value === "object"
          ? { ...record(standard[key]), ...record(value) }
          : value;
    }
    return standard as JSONObject;
  };
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: async ({ params }) => ({
        ...params,
        includeRawChunks: true,
      }),
      wrapGenerate: async ({ doGenerate }) => {
        const requestId = randomUUID();
        const result = await doGenerate();
        const body = record(result.response?.body);
        // response.body is the unparsed provider JSON; usage.raw may be schema-stripped.
        const raw =
          result.response?.body !== undefined ? body.usage : result.usage.raw;
        const extensions = extractExtendedUsage(raw);
        capture(extensions, requestId);
        return {
          ...result,
          usage: { ...result.usage, raw: completeRaw(raw, extensions) },
          providerMetadata: metadata(
            result.providerMetadata,
            raw,
            extensions,
            requestId,
          ),
        };
      },
      wrapStream: async ({ doStream }) => {
        const requestId = randomUUID();
        const result = await doStream();
        let raw: Record<string, unknown> = {};
        let extensions: Record<string, MetricScalar> = {};
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
                    extensions = mergeExtendedUsage(extensions, candidate);
                    raw = mergeRawUsage(raw, candidate);
                  }
                }
                if (part.type === "finish") {
                  const evidence = sawRawPart
                    ? raw
                    : whitelistRawUsage(part.usage.raw);
                  extensions = {
                    ...extractExtendedUsage(part.usage.raw),
                    ...extensions,
                  };
                  capture(extensions, requestId);
                  controller.enqueue({
                    ...part,
                    usage: {
                      ...part.usage,
                      raw: completeRaw(evidence, extensions),
                    },
                    providerMetadata: metadata(
                      part.providerMetadata,
                      evidence,
                      extensions,
                      requestId,
                    ),
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
