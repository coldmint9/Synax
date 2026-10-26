import type {
  AgentSession,
  AgentSessionMode,
} from "../../adapters/transport/agentRuntime";

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

export function readSessionBackendId(session?: AgentSession): string {
  const explicit = session?.sessionMetadata?.backend as
    | { id?: string }
    | undefined;
  if (explicit?.id) return explicit.id;
  const legacy = session?.sessionMetadata?.acp as
    | { providerId?: string; engineModel?: string }
    | undefined;
  const prefix = (legacy?.engineModel ?? session?.model)?.split("/")[0];
  const external = session?.sessionMetadata?.nativeBackend as { id?: string } | undefined;
  return (
    legacy?.providerId ??
    (prefix?.endsWith("-acp") ? prefix : legacy ? "retired" : external?.id || "native")
  );
}

/** Retired bindings remain readable so an old transcript never silently changes engine. */
export function isUnsupportedSessionBackend(session?: AgentSession): boolean {
  const id = readSessionBackendId(session);
  return id !== "native" || Boolean(session?.sessionMetadata?.acp);
}

export function isExternalSession(session?: AgentSession): boolean {
  return readSessionBackendId(session) !== "native" || Boolean(session?.sessionMetadata?.acp);
}

export function createSynaxSessionMetadata(
  mode: SynaxSessionMode,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return { mode, ...extras };
}

export type SynaxPermissionTier = "boundary" | "auto" | "unrestricted";

export const DEFAULT_SYNAX_PERMISSION_TIER: SynaxPermissionTier = "boundary";

export function isSynaxPermissionTier(
  value: unknown,
): value is SynaxPermissionTier {
  return value === "boundary" || value === "auto" || value === "unrestricted";
}

export const SYNAX_PERMISSION_TIER_LABELS: Record<
  SynaxPermissionTier,
  { titleKey: string; descKey: string }
> = {
  boundary: {
    titleKey: "agentPermTierBoundary",
    descKey: "agentPermTierBoundaryDesc",
  },
  auto: {
    titleKey: "agentPermTierAuto",
    descKey: "agentPermTierAutoDesc",
  },
  unrestricted: {
    titleKey: "agentPermTierUnrestricted",
    descKey: "agentPermTierUnrestrictedDesc",
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
  if (isSynaxPermissionTier(tier)) return tier;
  return DEFAULT_SYNAX_PERMISSION_TIER;
}
