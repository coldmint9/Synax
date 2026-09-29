import type { ApiFormat } from "../../../lib/config/config-types.js";
import type { InputModality } from "../../agent-runtime/content-parts.js";
import {
  MAX_FILE_BYTES,
  MAX_INPUT_BYTES,
} from "../../agent-runtime/content-parts.js";

/**
 * Media capability knowledge for adapters (npm packages) and for the remote
 * endpoints Synax ships profiles for.
 *
 * Why this module exists: whether media input was allowed used to be decided by
 * a hand-written npm allowlist inside the agent runtime. Any adapter missing
 * from that list silently discarded the modalities declared for the model —
 * DeepSeek over the Responses protocol (`@ai-sdk/open-responses`) was the
 * reported case, and cerebras/cohere/deepinfra/togetherai/openrouter carried
 * the same defect. The knowledge now lives next to the adapter registry, every
 * registered adapter is covered explicitly, and `media-profile.test.ts` fails
 * when a new adapter is added without a media declaration.
 *
 * Layer model:
 * - adapter profile  = what the SDK can serialize onto the wire
 * - endpoint profile = what the remote API accepts, and at which limits
 * The agent runtime intersects both with the model's declared modalities.
 */

export interface MediaLimits {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
}

export interface MediaSpec {
  /** Modalities this layer can carry. */
  carriers: InputModality[];
  /** MIME patterns this layer can carry; a trailing `/*` matches a prefix. */
  mediaTypes?: string[];
  limits?: MediaLimits;
}

export interface AdapterMediaProfile {
  /** Modalities the wire can carry; omitted when the adapter is unverified. */
  carriers?: InputModality[];
  mediaTypes?: string[];
  limits?: MediaLimits;
  /** Protocol-specific override, e.g. Responses accepts documents Chat cannot. */
  byApiFormat?: Partial<Record<ApiFormat, MediaSpec>>;
  /**
   * Set when Synax has no verified knowledge of this adapter's media parts. A
   * declaration is still honoured and reported as `declared` instead of being
   * turned into a silent text-only rejection.
   */
  unverified?: true;
}

const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];
const DOCUMENT_TYPES = ["application/pdf", "text/plain"];
const RESPONSES_DOCUMENT_TYPES = [
  ...DOCUMENT_TYPES,
  "text/csv",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];
const CHAT_AUDIO_TYPES = ["audio/wav", "audio/mpeg"];

/** The installed OpenAI Chat adapter has native image, PDF and WAV/MP3 parts. */
const OPENAI_CHAT_SPEC: MediaSpec = {
  carriers: ["text", "image", "audio", "file"],
  mediaTypes: [...IMAGE_TYPES, "application/pdf", ...CHAT_AUDIO_TYPES],
  limits: {
    maxFileBytes: MAX_FILE_BYTES,
    maxTotalBytes: MAX_FILE_BYTES,
    maxFiles: 500,
  },
};
const OPENAI_RESPONSES_SPEC: MediaSpec = {
  carriers: ["text", "image", "file"],
  mediaTypes: [...IMAGE_TYPES, ...RESPONSES_DOCUMENT_TYPES],
  limits: {
    maxFileBytes: MAX_FILE_BYTES,
    maxTotalBytes: MAX_FILE_BYTES,
    maxFiles: 500,
  },
};

/** Chat adapters that ship image parts but no document parts. */
const IMAGE_ONLY_SPEC: MediaSpec = {
  carriers: ["text", "image"],
  mediaTypes: IMAGE_TYPES,
};

/** Explicitly unverified: the declaration decides, and the UI says so. */
const UNVERIFIED_ADAPTER: AdapterMediaProfile = { unverified: true };

/**
 * Every npm package the runtime can instantiate must appear here (see
 * `media-profile.test.ts`), either with `carriers` or as
 * `unverified`. `image/*`-style patterns are matched by prefix.
 */
export const ADAPTER_MEDIA_PROFILES: Record<string, AdapterMediaProfile> = {
  "@ai-sdk/anthropic": {
    carriers: ["text", "image", "file"],
    mediaTypes: [...IMAGE_TYPES, ...DOCUMENT_TYPES],
    limits: { maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 24 * 1024 * 1024 },
  },
  "@ai-sdk/cerebras": UNVERIFIED_ADAPTER,
  "@ai-sdk/cohere": UNVERIFIED_ADAPTER,
  "@ai-sdk/deepinfra": UNVERIFIED_ADAPTER,
  "@ai-sdk/deepseek": IMAGE_ONLY_SPEC,
  "@ai-sdk/google": {
    carriers: ["text", "image", "audio", "video", "file"],
    mediaTypes: [
      ...IMAGE_TYPES,
      ...DOCUMENT_TYPES,
      "audio/*",
      "video/*",
    ],
    limits: { maxFileBytes: 20 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 },
  },
  "@ai-sdk/groq": IMAGE_ONLY_SPEC,
  "@ai-sdk/mistral": IMAGE_ONLY_SPEC,
  "@ai-sdk/open-responses": OPENAI_RESPONSES_SPEC,
  "@ai-sdk/openai": {
    ...OPENAI_CHAT_SPEC,
    byApiFormat: { "openai-responses": OPENAI_RESPONSES_SPEC },
  },
  "@ai-sdk/openai-compatible": OPENAI_CHAT_SPEC,
  "@ai-sdk/perplexity": IMAGE_ONLY_SPEC,
  "@ai-sdk/togetherai": UNVERIFIED_ADAPTER,
  "@ai-sdk/xai": IMAGE_ONLY_SPEC,
  "@openrouter/ai-sdk-provider": UNVERIFIED_ADAPTER,
};

export interface EndpointMediaContext {
  providerId?: string;
  modelId?: string;
  baseUrl?: string;
}

export interface EndpointMediaProfile {
  id: string;
  /** Documentation the profile is derived from, for maintenance. */
  doc: string;
  matches(context: EndpointMediaContext): boolean;
  /** Endpoint-specific restrictions, intersected with the adapter profile. */
  restrict: MediaSpec;
}

function mentions(
  context: EndpointMediaContext,
  fragment: string,
): boolean {
  return [context.providerId, context.modelId, context.baseUrl].some((value) =>
    value?.toLowerCase().includes(fragment),
  );
}

/**
 * Endpoint restrictions Synax knows from provider documentation. A profile only
 * narrows the adapter profile — it never widens it.
 */
export const ENDPOINT_MEDIA_PROFILES: EndpointMediaProfile[] = [
  {
    id: "deepseek",
    doc: "https://api-docs.deepseek.com/guides/vision",
    // Same predicate the resolver uses to route DeepSeek to its adapter.
    matches: (context) => mentions(context, "deepseek"),
    restrict: {
      // Vision: "Images are supported in user messages only", and the Responses
      // guide states "File inputs are not supported" — so `file` is absent.
      carriers: ["text", "image"],
      // Documented formats: JPEG, PNG, GIF, WebP (sniffed from content).
      mediaTypes: IMAGE_TYPES,
      limits: {
        // Limits table: 32 MiB per inline image, 48 MiB request body. Synax
        // sends assets inline as base64, so the body limit is the binding one.
        maxFileBytes: 32 * 1024 * 1024,
        maxTotalBytes: 48 * 1024 * 1024,
        // 600 images per request; the request schema already caps input at 10.
        maxFiles: 600,
      },
    },
  },
];

export interface ResolvedMediaProfile {
  /** Modalities the wire can carry; undefined when the adapter is unverified. */
  carriers?: InputModality[];
  mediaTypes?: string[];
  limits: MediaLimits;
  /** Endpoint profiles that narrowed the result, for diagnostics. */
  endpointIds: string[];
}

/** `outer` covers `inner` when they are equal or `outer` is a broader wildcard. */
function patternCovers(outer: string, inner: string): boolean {
  if (outer === inner) return true;
  if (!outer.endsWith("/*")) return false;
  return inner.startsWith(outer.slice(0, -1));
}

function intersectPatterns(
  left?: string[],
  right?: string[],
): string[] | undefined {
  if (!left) return right;
  if (!right) return left;
  const narrowed = left.filter((pattern) =>
    right.some((other) => patternCovers(other, pattern)),
  );
  return [...new Set(narrowed)];
}

function minimumLimit(
  ...values: Array<number | undefined>
): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? Math.min(...present) : undefined;
}

function intersectLimits(
  ...layers: Array<MediaLimits | undefined>
): MediaLimits {
  const key = (name: keyof MediaLimits) =>
    minimumLimit(...layers.map((layer) => layer?.[name]));
  return {
    maxFileBytes: key("maxFileBytes"),
    maxTotalBytes: key("maxTotalBytes"),
    maxFiles: key("maxFiles"),
  };
}

function adapterSpec(
  profile: AdapterMediaProfile | undefined,
  apiFormat?: ApiFormat,
): AdapterMediaProfile | MediaSpec | undefined {
  if (!profile) return undefined;
  const override = apiFormat ? profile.byApiFormat?.[apiFormat] : undefined;
  return override ?? profile;
}

/**
 * Resolves what a provider connection can actually receive: the adapter's wire
 * capability narrowed by the endpoint profile for that provider/base URL.
 */
export function resolveMediaProfile(input: {
  npm?: string;
  apiFormat?: ApiFormat;
  providerId?: string;
  modelId?: string;
  baseUrl?: string;
}): ResolvedMediaProfile {
  const adapter = adapterSpec(
    input.npm ? ADAPTER_MEDIA_PROFILES[input.npm] : undefined,
    input.apiFormat,
  );
  const endpoints = ENDPOINT_MEDIA_PROFILES.filter((profile) =>
    profile.matches(input),
  );
  const carriers = [adapter, ...endpoints.map((e) => e.restrict)]
    .map((layer) => layer?.carriers)
    .reduce<InputModality[] | undefined>(
      (current, next) =>
        current === undefined
          ? next
          : next === undefined
            ? current
            : current.filter((modality) => next.includes(modality)),
      undefined,
    );
  const mediaTypes = [adapter, ...endpoints.map((e) => e.restrict)].reduce<
    string[] | undefined
  >(
    (current, layer) => intersectPatterns(current, layer?.mediaTypes),
    undefined,
  );
  return {
    carriers,
    mediaTypes,
    limits: intersectLimits(
      adapter?.limits,
      ...endpoints.map((endpoint) => endpoint.restrict.limits),
    ),
    endpointIds: endpoints.map((endpoint) => endpoint.id),
  };
}
