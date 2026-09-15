import { createHash } from "node:crypto";
import { wrapLanguageModel } from "ai";
import { asSchema } from "@ai-sdk/provider-utils";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from "@ai-sdk/provider";
import type { LlmGatewayRequest } from "./types.js";

export interface CacheBlockFingerprint {
  kind: "system" | "reference" | "tools" | "history" | "runtime";
  fingerprint: string;
  bytes: number;
}
export interface CacheRequestFingerprint {
  version: 1;
  blocks: CacheBlockFingerprint[];
}
export interface CacheRequestComparison {
  unchanged: boolean;
  commonPrefixBlocks: number;
  firstChange: {
    index: number;
    before: CacheBlockFingerprint["kind"] | null;
    after: CacheBlockFingerprint["kind"] | null;
  } | null;
  stableSystem: boolean;
  stableTools: boolean;
  stableReferences: boolean;
}
export function cacheDiagnosticsEnabled(): boolean {
  return process.env.SYNAX_PROMPT_CACHE_DIAGNOSTICS === "1";
}
function block(
  kind: CacheBlockFingerprint["kind"],
  value: unknown,
): CacheBlockFingerprint {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return {
    kind,
    fingerprint: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text),
  };
}
/** Only fingerprints/lengths leave this function. Message bodies remain in memory. */
export function fingerprintRequest(
  messages: readonly {
    role: string;
    content: unknown;
    providerOptions?: unknown;
  }[],
  tools: unknown = [],
): CacheRequestFingerprint {
  const blocks: CacheBlockFingerprint[] = [block("tools", tools)];
  for (const message of messages) {
    const content = message.content;
    if (message.role === "system" && typeof content === "string") {
      const start = content.indexOf("<reference-context>");
      const end =
        start < 0 ? -1 : content.indexOf("</reference-context>", start);
      if (start >= 0 && end >= 0) {
        const boundary = end + "</reference-context>".length;
        blocks.push(
          block("system", {
            content: content.slice(0, start) + content.slice(boundary),
            providerOptions: message.providerOptions,
          }),
        );
        blocks.push(block("reference", content.slice(start, boundary)));
      } else blocks.push(block("system", message));
    } else {
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content) &&
              content.length === 1 &&
              content[0]?.type === "text"
            ? content[0].text
            : "";
      blocks.push(
        block(
          message.role === "system"
            ? "system"
            : message.role === "user" && text.startsWith("<system-reminder>\n")
              ? "runtime"
              : "history",
          message,
        ),
      );
    }
  }
  return { version: 1, blocks };
}
export async function fingerprintGatewayRequest(
  request: Pick<LlmGatewayRequest, "messages" | "tools" | "activeTools">,
): Promise<CacheRequestFingerprint> {
  const definitions = [];
  for (const [name, tool] of Object.entries(request.tools ?? {})) {
    if (request.activeTools && !request.activeTools.includes(name)) continue;
    definitions.push({
      name,
      description: tool.description,
      inputSchema: await asSchema(tool.inputSchema).jsonSchema,
      providerOptions: tool.providerOptions,
    });
  }
  return fingerprintRequest(request.messages, definitions);
}
export function compareRequests(
  previous: CacheRequestFingerprint,
  current: CacheRequestFingerprint,
): CacheRequestComparison {
  let index = 0;
  while (
    index < previous.blocks.length &&
    index < current.blocks.length &&
    previous.blocks[index].kind === current.blocks[index].kind &&
    previous.blocks[index].fingerprint === current.blocks[index].fingerprint
  )
    index++;
  const unchanged =
    index === previous.blocks.length && index === current.blocks.length;
  const sameKind = (kind: CacheBlockFingerprint["kind"]) =>
    JSON.stringify(previous.blocks.filter((b) => b.kind === kind)) ===
    JSON.stringify(current.blocks.filter((b) => b.kind === kind));
  return {
    unchanged,
    commonPrefixBlocks: index,
    firstChange: unchanged
      ? null
      : {
          index,
          before: previous.blocks[index]?.kind ?? null,
          after: current.blocks[index]?.kind ?? null,
        },
    stableSystem: sameKind("system"),
    stableTools: sameKind("tools"),
    stableReferences: sameKind("reference"),
  };
}

/** Provider-adapter boundary, before serialization. Wire correctness is tested separately. */
export function applyCacheDiagnosticsMiddleware(
  model: LanguageModelV4,
  context: {
    provider: string;
    model: string;
    protocol: string;
    requestId?: string;
    source?: string;
    phase?: string;
  },
): LanguageModelV4 {
  const snapshot = (params: LanguageModelV4CallOptions) =>
    fingerprintRequest(params.prompt, params.tools);
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ params, doGenerate }) => {
        const started = performance.now();
        const request = snapshot(params);
        const result = await doGenerate();
        return {
          ...result,
          providerMetadata: {
            ...result.providerMetadata,
            synax: {
              ...result.providerMetadata?.synax,
              cacheDiagnostics: {
                ...context,
                boundary: "adapter",
                request,
                durationMs: performance.now() - started,
                firstTokenMs: null,
              } as never,
            },
          },
        };
      },
      wrapStream: async ({ params, doStream }) => {
        const started = performance.now();
        const request = snapshot(params);
        let firstTokenMs: number | null = null;
        const result = await doStream();
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                if (
                  firstTokenMs === null &&
                  (part.type === "text-delta" ||
                    part.type === "reasoning-delta") && part.delta.length > 0
                )
                  firstTokenMs = performance.now() - started;
                if (part.type === "finish")
                  controller.enqueue({
                    ...part,
                    providerMetadata: {
                      ...part.providerMetadata,
                      synax: {
                        ...part.providerMetadata?.synax,
                        cacheDiagnostics: {
                          ...context,
                          boundary: "adapter",
                          request,
                          durationMs: performance.now() - started,
                          firstTokenMs,
                        } as never,
                      },
                    },
                  });
                else controller.enqueue(part);
              },
            }),
          ),
        };
      },
    },
  });
}

export interface CacheMeasurement {
  provider: string;
  model: string;
  source: string;
  phase: string;
  usage?: unknown;
  durationMs?: number | null;
  firstTokenMs?: number | null;
  cost?: number | null;
}
/** Aggregation accepts provider usage, never estimated prefix token matches. */
export async function summarizeCacheMeasurements(records: CacheMeasurement[]) {
  const { normalizeUsage } = await import("./usage.js");
  const groups = new Map<
    string,
    {
      provider: string;
      model: string;
      source: string;
      phase: string;
      requests: number;
      cacheReadKnown: number;
      cacheWriteKnown: number;
      cacheRead: number;
      cacheWrite: number;
      matchedInput: number;
      matchedCacheRead: number;
      durationMs: number[];
      firstTokenMs: number[];
      costs: number[];
    }
  >();
  for (const record of records) {
    const key = JSON.stringify([
      record.provider,
      record.model,
      record.source,
      record.phase,
    ]);
    let group = groups.get(key);
    if (!group) {
      group = {
        provider: record.provider,
        model: record.model,
        source: record.source,
        phase: record.phase,
        requests: 0,
        cacheReadKnown: 0,
        cacheWriteKnown: 0,
        cacheRead: 0,
        cacheWrite: 0,
        matchedInput: 0,
        matchedCacheRead: 0,
        durationMs: [],
        firstTokenMs: [],
        costs: [],
      };
      groups.set(key, group);
    }
    group.requests++;
    const usage = normalizeUsage(record.usage);
    if (usage?.cachedInputTokens !== undefined) {
      group.cacheReadKnown++;
      group.cacheRead += usage.cachedInputTokens;
      if (usage.inputTokens !== undefined) {
        group.matchedInput += usage.inputTokens;
        group.matchedCacheRead += usage.cachedInputTokens;
      }
    }
    if (usage?.cacheWriteTokens !== undefined) {
      group.cacheWriteKnown++;
      group.cacheWrite += usage.cacheWriteTokens;
    }
    const finite = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0;
    if (finite(record.durationMs)) group.durationMs.push(record.durationMs);
    if (finite(record.firstTokenMs))
      group.firstTokenMs.push(record.firstTokenMs);
    if (finite(record.cost)) group.costs.push(record.cost);
  }
  const mean = (values: number[]) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return [...groups.values()].map((group) => ({
    ...group,
    cacheRead: group.cacheReadKnown ? group.cacheRead : null,
    cacheWrite: group.cacheWriteKnown ? group.cacheWrite : null,
    cacheReadCoverage: group.cacheReadKnown / group.requests,
    cacheWriteCoverage: group.cacheWriteKnown / group.requests,
    cacheReadRate: group.matchedInput
      ? group.matchedCacheRead / group.matchedInput
      : null,
    durationMs: mean(group.durationMs),
    firstTokenMs: mean(group.firstTokenMs),
    cost: group.costs.length ? group.costs.reduce((a, b) => a + b, 0) : null,
    costKnown: group.costs.length,
  }));
}

/** Validate persisted diagnostic metadata without copying any unrecognized fields. */
export function readCacheFingerprint(value: unknown): CacheRequestFingerprint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as CacheRequestFingerprint;
  const kinds = new Set(['system', 'reference', 'tools', 'history', 'runtime']);
  if (candidate.version !== 1 || !Array.isArray(candidate.blocks) || !candidate.blocks.every(item => item && kinds.has(item.kind) && /^[a-f0-9]{64}$/.test(item.fingerprint) && Number.isSafeInteger(item.bytes) && item.bytes >= 0)) return undefined;
  return { version: 1, blocks: candidate.blocks.map(item => ({ kind: item.kind, fingerprint: item.fingerprint, bytes: item.bytes })) };
}
