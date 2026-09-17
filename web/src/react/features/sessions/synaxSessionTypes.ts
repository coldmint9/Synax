import type {
  AgentSession,
  AgentSessionMode,
  BackendId,
} from "../../../lib/api/agentRuntime";

export const SYNAX_PROFILE_ID = "synax";

export type SynaxSessionMode = AgentSessionMode | "plan_node";

export function readSynaxSessionMode(
  metadata: Record<string, unknown> | null | undefined,
): SynaxSessionMode {
  const mode = metadata?.mode;
  return mode === "plan" || mode === "goal" || mode === "plan_node"
    ? mode
    : "chat";
}

export function readSessionBackendId(session?: AgentSession): BackendId {
  const explicit = session?.sessionMetadata?.backend as
    | { id?: BackendId }
    | undefined;
  if (explicit?.id) return explicit.id;
  const legacy = session?.sessionMetadata?.acp as
    | { providerId?: BackendId }
    | undefined;
  const prefix = session?.model?.split("/")[0];
  return (
    legacy?.providerId ??
    (prefix?.endsWith("-acp") ? (prefix as BackendId) : "native")
  );
}

export function isAcpSession(
  session?: AgentSession,
  model?: string | null,
): boolean {
  if (session?.sessionMetadata?.backend)
    return readSessionBackendId(session) !== "native";
  return (
    Boolean(session?.sessionMetadata?.acp) ||
    [model, session?.model].some((value) =>
      value?.split("/")[0].endsWith("-acp"),
    )
  );
}

export function createSynaxSessionMetadata(
  mode: SynaxSessionMode,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return { mode, ...extras };
}

export type SynaxPermissionTier = "boundary" | "auto" | "unrestricted";

export type SynaxWikiAttachMode = "auto" | "manual";

export const DEFAULT_SYNAX_PERMISSION_TIER: SynaxPermissionTier = "boundary";

export const SYNAX_PERMISSION_TIER_LABELS: Record<
  SynaxPermissionTier,
  { titleKey: string; descKey: string }
> = {
  boundary: {
    titleKey: "goalPermTierBoundary",
    descKey: "goalPermTierBoundaryDesc",
  },
  auto: {
    titleKey: "goalPermTierAuto",
    descKey: "goalPermTierAutoDesc",
  },
  unrestricted: {
    titleKey: "goalPermTierUnrestricted",
    descKey: "goalPermTierUnrestrictedDesc",
  },
};

export function hasNonDefaultSynaxPermissionTier(
  tier: SynaxPermissionTier,
): boolean {
  return tier !== DEFAULT_SYNAX_PERMISSION_TIER;
}

export function readSynaxPermissionTier(
  metadata: Record<string, unknown> | null | undefined,
): SynaxPermissionTier {
  const tier = metadata?.permissionTier;
  if (tier === "boundary" || tier === "auto" || tier === "unrestricted") {
    return tier;
  }
  return DEFAULT_SYNAX_PERMISSION_TIER;
}

export function readSynaxWikiAttachMode(
  metadata: Record<string, unknown> | null | undefined,
): SynaxWikiAttachMode {
  return metadata?.wikiAttachMode === "manual" ? "manual" : "auto";
}

export function readSynaxDocumentId(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const id = metadata?.documentId;
  return typeof id === "string" && id.length > 0 ? id : null;
}
