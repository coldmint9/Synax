import fs from "node:fs";
import path from "node:path";
import * as z from "zod/v4";
import type {
  AgentProfile,
  AgentSession,
  CreateSessionRequest,
  PermissionRule,
  ThinkingMode,
} from "./contracts.js";
import {
  capabilityCategorySchema,
  internalGateSchema,
  permissionOverridesSchema,
  permissionTierSchema,
  thinkingModeSchema,
} from "./contracts.js";
import {
  AgentPermissionError,
  AgentValidationError,
} from "./runtime-errors.js";
import { sandboxPolicy } from "./sandbox/index.js";
import { inferSynaxSessionMode } from "./synax/synax-session-mode.js";
import { parseApplyPatchEnvelope } from "./tools/patch-format.js";
import {
  resolveSessionWorkDir,
  setSessionWorkspaceRoot,
} from "./tools/workspace.js";
import { matchWildcard } from "./wildcard.js";

export const SPECIALIST_PROFILE_ID = "specialist";

const READ_CAPABILITIES = [
  "file.read",
  "media.read",
  "file.list",
  "rg",
  "webSearch",
  "diff.read",
  "wiki.get_snapshot",
  "wiki.get_tree",
  "wiki.search_content",
  "wiki.search_batch",
  "wiki.read_document",
  "wiki.read_section",
  "wiki.get_references",
];
const WRITE_CAPABILITIES = ["file.write", "edit", "file.delete"];
const SAFE_CAPABILITIES = [
  ...READ_CAPABILITIES,
  ...WRITE_CAPABILITIES,
  "task.create",
  "task.update",
  "task.get",
  "task.list",
  "skill.load",
];
const identifierSchema = z.string().trim().min(1).max(128);
const unique = (values: string[]): string[] => [...new Set(values)];
const relativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    return (
      value === value.trim() &&
      !path.posix.isAbsolute(value) &&
      !/[\\:*?%\x00-\x1f\x7f]/.test(value) &&
      !value.startsWith("~") &&
      !value.split("/").includes("..") &&
      path.posix.normalize(value).replace(/\/$/, "") !== "."
    );
  }, "writeScope and write paths must be safe relative paths, not roots, traversal or globs.")
  .transform((value) => path.posix.normalize(value).replace(/\/$/, ""));

export interface SpecialistSpec {
  name: string;
  role: string;
  instructions: string;
  capabilities: string[];
  skillIds: string[];
  writeScope?: string[];
}

export const specialistSpecSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    role: z.string().trim().min(1).max(256),
    instructions: z.string().trim().min(1).max(16_000),
    capabilities: z
      .array(identifierSchema)
      .max(32)
      .default([])
      .transform(unique),
    skillIds: z.array(identifierSchema).max(20).default([]).transform(unique),
    writeScope: z
      .array(relativePathSchema)
      .min(1)
      .max(32)
      .transform(unique)
      .optional(),
  })
  .strict();

const taskSchema = z
  .object({
    specialist: specialistSpecSchema,
    prompt: z.string().trim().min(1).max(20_000),
    deliverable: z.string().trim().min(1).max(4_000).optional(),
    acceptanceCriteria: z
      .array(z.string().trim().min(1).max(1_000))
      .max(20)
      .default([])
      .transform(unique),
    thinkingMode: thinkingModeSchema.optional(),
  })
  .strict();
const modeSchema = z.enum(["chat", "plan", "goal", "plan_node"]);
const permissionRuleSchema = z.object({
  gate: z.union([capabilityCategorySchema, internalGateSchema, z.literal("*"), z.literal("approval_mode")]),
  pattern: z.string().min(1).max(1024),
  action: z.enum(["allow", "ask", "deny"]),
  reason: z.string().max(2_000).optional(),
});
const snapshotSchema = specialistSpecSchema.extend({
  version: z.literal(1),
  parentSessionId: identifierSchema,
  projectId: identifierSchema,
  parentMode: modeSchema,
  workspaceRoot: z.string().min(1).max(4096),
  permissionRules: z.array(permissionRuleSchema).max(128),
  prompt: taskSchema.shape.prompt,
  deliverable: taskSchema.shape.deliverable,
  acceptanceCriteria: taskSchema.shape.acceptanceCriteria,
});
type SpecialistSnapshot = z.infer<typeof snapshotSchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AgentValidationError(
      `Invalid specialist configuration: ${result.error.message}`,
    );
  return result.data;
}

function assertSpec(spec: SpecialistSpec, mode: string): void {
  const forbidden = spec.capabilities.find(
    (capability) => !SAFE_CAPABILITIES.includes(capability),
  );
  if (forbidden)
    throw new AgentPermissionError(
      `Specialists cannot use capability ${forbidden}.`,
    );
  if (
    spec.capabilities.some((capability) =>
      WRITE_CAPABILITIES.includes(capability),
    )
  ) {
    if (mode === "plan")
      throw new AgentPermissionError("Plan specialists cannot write files.");
    if (!spec.writeScope?.length)
      throw new AgentPermissionError(
        "File writes require an explicit writeScope.",
      );
  }
}

function restrictions(
  spec: Pick<SpecialistSpec, "capabilities">,
): PermissionRule[] {
  const gates: PermissionRule["gate"][] = [
    "shell",
    "mcp",
    "external_execution",
    "external_path",
    "task",
  ];
  if (
    !spec.capabilities.some((capability) =>
      WRITE_CAPABILITIES.includes(capability),
    )
  )
    gates.push("write");
  if (!spec.capabilities.includes("file.delete")) gates.push("delete");
  return gates.map((gate) => ({
    gate,
    pattern: "*",
    action: "deny",
    reason: "Specialist privilege boundary.",
  }));
}

export const specialistBaseProfile: AgentProfile = {
  id: SPECIALIST_PROFILE_ID,
  label: "Specialist",
  kind: "executor",
  mode: "subagent",
  description:
    "A bounded, session-local specialist with an immutable task and privilege snapshot.",
  defaultThinkingMode: "standard",
  allowedCapabilities: [...SAFE_CAPABILITIES],
  permissionDefaults: [
    { gate: "read", pattern: "*", action: "allow" },
    ...restrictions({ capabilities: [] }),
  ],
  maxSteps: 16,
  status: "active",
  allowsSubsessions: false,
  toolPolicy: {
    allowSubtasks: false,
    allowParallelReadTools: true,
    maxParallelReadTools: 4,
  },
  loopHints: [
    "Complete only the assigned task. Return questions and blockers to the parent; never delegate or invoke shell/external tools.",
  ],
};

// Match the existing permission policy's last-match-wins semantics. TODO tools
// have internalGate=none: a task-gate rule restricts delegation, not local TODOs.
function assertInheritedPermission(
  snapshot: SpecialistSnapshot,
  toolId: string,
  pattern: string,
): void {
  const category = WRITE_CAPABILITIES.includes(toolId)
    ? "write"
    : toolId === "skill.load"
      ? "skill"
      : toolId === "subagent.delegate" || toolId.startsWith("task.")
        ? "task"
        : "read";
  const gate =
    toolId === "subagent.delegate"
      ? "task"
      : toolId === "file.delete"
        ? "delete"
        : category === "write"
          ? "write"
          : category === "skill"
            ? "skill"
            : "none";
  const rule = [...snapshot.permissionRules]
    .reverse()
    .find(
      (candidate) =>
        (candidate.gate === "task"
          ? gate === "task"
          : candidate.gate === "*" ||
            candidate.gate === category ||
            candidate.gate === gate) &&
        matchWildcard(pattern, candidate.pattern),
    );
  if (rule?.action === "deny")
    throw new AgentPermissionError(
      `Parent permissions deny ${toolId} on ${pattern}.`,
    );
}

// Sandbox resolves existing symlinks, but a dangling link looks nonexistent to
// its nearest-ancestor fallback. Reject link components for specialist writes.
function assertNoSymlinks(relative: string, root: string): void {
  let current = path.resolve(root, relative);
  while (current !== root) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new AgentPermissionError(
        "Specialist write paths cannot contain symlinks.",
      );
    }
    current = path.dirname(current);
  }
}

export function buildSpecialistChildInput(
  parent: AgentSession,
  args: {
    specialist: SpecialistSpec;
    prompt: string;
    deliverable?: string;
    acceptanceCriteria?: string[];
    thinkingMode?: ThinkingMode;
  },
  parentProfile: AgentProfile,
): CreateSessionRequest {
  if (
    parent.parentSessionId ||
    parent.profileId === SPECIALIST_PROFILE_ID ||
    parent.sessionMetadata?.specialist != null ||
    parentProfile.mode === "subagent"
  ) {
    throw new AgentPermissionError(
      "Specialists support only one level of children.",
    );
  }
  if (
    parentProfile.id !== parent.profileId ||
    parentProfile.status !== "active" ||
    parentProfile.toolPolicy?.allowSubtasks === false ||
    !parentProfile.allowedCapabilities.includes("subagent.delegate")
  ) {
    throw new AgentPermissionError(
      "Parent effective profile cannot delegate specialists.",
    );
  }
  const input = parse(taskSchema, args);
  const parentMode = parse(
    modeSchema,
    parent.sessionMetadata?.mode ?? inferSynaxSessionMode(parent),
  );
  assertSpec(input.specialist, parentMode);
  for (const capability of input.specialist.capabilities) {
    if (!parentProfile.allowedCapabilities.includes(capability))
      throw new AgentPermissionError(
        `Capability ${capability} exceeds the parent effective profile.`,
      );
  }
  for (const skillId of input.specialist.skillIds) {
    if (!parent.skillIds.includes(skillId))
      throw new AgentPermissionError(
        `Skill ${skillId} is not assigned to the parent.`,
      );
  }
  const workspaceRoot = fs.realpathSync(
    resolveSessionWorkDir(parent.id, parent.projectId),
  );
  for (const scope of input.specialist.writeScope ?? []) {
    assertNoSymlinks(scope, workspaceRoot);
    sandboxPolicy.resolve(scope, workspaceRoot, parent.id, "subagent.delegate");
  }
  const snapshot = parse(snapshotSchema, {
    ...input.specialist,
    version: 1,
    parentSessionId: parent.id,
    projectId: parent.projectId,
    parentMode,
    workspaceRoot,
    permissionRules: parent.permissionRules,
    prompt: input.prompt,
    deliverable: input.deliverable,
    acceptanceCriteria: input.acceptanceCriteria,
  });
  assertInheritedPermission(snapshot, "subagent.delegate", "subagent.delegate");
  for (const capability of snapshot.capabilities) {
    const patterns = WRITE_CAPABILITIES.includes(capability)
      ? snapshot.writeScope!
      : [capability];
    for (const pattern of patterns)
      assertInheritedPermission(snapshot, capability, pattern);
  }
  const writes = snapshot.capabilities.some((capability) =>
    WRITE_CAPABILITIES.includes(capability),
  );
  const tier = parse(
    permissionTierSchema.optional(),
    parent.sessionMetadata?.permissionTier,
  );
  const permissionTier = writes
    ? tier === "unrestricted"
      ? "auto"
      : (tier ?? "boundary")
    : "boundary";
  const permissionOverrides = {
    ...parse(
      permissionOverridesSchema.optional(),
      parent.sessionMetadata?.permissionOverrides,
    ),
    shell: "deny" as const,
    ...(!writes ? { write: "deny" as const } : {}),
    ...(!snapshot.capabilities.includes("file.delete")
      ? { delete: "deny" as const }
      : {}),
  };
  // Do not copy engine/MCP settings, goal state, or approval grants from arbitrary
  // metadata. Copy effective rules last so child tier defaults cannot override them.
  return {
    projectId: parent.projectId,
    nodeId: parent.nodeId,
    parentSessionId: parent.id,
    profileId: SPECIALIST_PROFILE_ID,
    prompt: [
      input.prompt,
      input.deliverable && `Deliverable: ${input.deliverable}`,
      input.acceptanceCriteria.length &&
        `Acceptance criteria:\n${input.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    thinkingMode: input.thinkingMode ?? parent.thinkingMode,
    reasoningEffort: parent.reasoningEffort ?? undefined,
    skillIds: [...snapshot.skillIds],
    mcpServerIds: [],
    permissionTier,
    permissionOverrides,
    sessionMetadata: {
      mode: parentMode,
      workspaceRoot,
      permissionTier,
      permissionOverrides: { ...permissionOverrides },
      specialist: snapshot,
      alwaysPermissionRules: [
        ...snapshot.permissionRules.map((rule) => ({ ...rule })),
        ...restrictions(snapshot),
      ],
    },
  };
}

function readSnapshot(session: AgentSession): SpecialistSnapshot | undefined {
  if (
    session.profileId !== SPECIALIST_PROFILE_ID &&
    session.sessionMetadata?.specialist == null
  )
    return undefined;
  const snapshot = parse(snapshotSchema, session.sessionMetadata?.specialist);
  if (
    session.profileId !== SPECIALIST_PROFILE_ID ||
    snapshot.parentSessionId !== session.parentSessionId ||
    snapshot.projectId !== session.projectId
  ) {
    throw new AgentPermissionError(
      "Specialist snapshot does not match its child session.",
    );
  }
  assertSpec(snapshot, snapshot.parentMode);
  assertSpec(snapshot, String(session.sessionMetadata?.mode));
  return snapshot;
}

export function resolveSpecialistProfile(
  base: AgentProfile,
  session: AgentSession,
): AgentProfile {
  const snapshot = readSnapshot(session);
  if (!snapshot) return base;
  return {
    ...base,
    id: SPECIALIST_PROFILE_ID,
    label: snapshot.name,
    description: snapshot.role,
    kind: "executor",
    mode: "subagent",
    allowsSubsessions: false,
    toolProviderId: undefined,
    allowedCapabilities: snapshot.capabilities.filter((capability) =>
      base.allowedCapabilities.includes(capability),
    ),
    defaultThinkingMode: session.thinkingMode,
    maxSteps: Math.min(base.maxSteps, specialistBaseProfile.maxSteps),
    toolPolicy: { ...base.toolPolicy, allowSubtasks: false },
    permissionDefaults: [
      { gate: "read", pattern: "*", action: "allow" },
      { gate: "write", pattern: "*", action: "ask" },
      { gate: "delete", pattern: "*", action: "ask" },
      ...snapshot.permissionRules,
      ...restrictions(snapshot),
    ],
    loopHints: [
      ...specialistBaseProfile.loopHints!,
      `Role: ${snapshot.role}`,
      snapshot.instructions,
      `Task: ${snapshot.prompt}`,
      ...(snapshot.deliverable ? [`Deliverable: ${snapshot.deliverable}`] : []),
      ...snapshot.acceptanceCriteria.map(
        (criterion) => `Acceptance criterion: ${criterion}`,
      ),
      snapshot.capabilities.some((capability) =>
        WRITE_CAPABILITIES.includes(capability),
      )
        ? `File writes are limited to: ${snapshot.writeScope!.join(", ")}.`
        : "Read-only: do not write files.",
    ],
  };
}

/** Call before execution AND permission resume. Ordinary permission approval,
 * terminal guards, and writer serialization remain the runtime's job. */
export function assertSpecialistToolAllowed(
  session: AgentSession,
  toolId: string,
  args: unknown,
): void {
  const snapshot = readSnapshot(session);
  if (!snapshot) return;
  if (!snapshot.capabilities.includes(toolId))
    throw new AgentPermissionError(
      `Tool ${toolId} is not assigned to this specialist.`,
    );
  if (toolId === "skill.load") {
    const { skillId } = parse(z.object({ skillId: identifierSchema }), args);
    if (
      !snapshot.skillIds.includes(skillId) ||
      !session.skillIds.includes(skillId)
    )
      throw new AgentPermissionError(
        `Skill ${skillId} is outside the specialist assignment.`,
      );
  }
  if (
    !path.isAbsolute(snapshot.workspaceRoot) ||
    fs.realpathSync(snapshot.workspaceRoot) !== snapshot.workspaceRoot
  ) {
    throw new AgentPermissionError("Specialist workspace root changed.");
  }
  // Restore the persisted root after restart; tools must use the same root as
  // this guard, not process.cwd() or a newly changed project registry entry.
  setSessionWorkspaceRoot(session.id, snapshot.workspaceRoot);
  if (!WRITE_CAPABILITIES.includes(toolId)) {
    const requestedPath =
      typeof args === "object" && args !== null && "path" in args
        ? args.path
        : undefined;
    assertInheritedPermission(
      snapshot,
      toolId,
      (toolId === "file.read" || toolId === "media.read") &&
        typeof requestedPath === "string"
        ? requestedPath
        : toolId,
    );
    return;
  }

  const write = parse(
    z.object({
      path: relativePathSchema,
      patch: z.string().optional(),
      content: z.string().optional(),
    }),
    args,
  );
  assertNoSymlinks(write.path, snapshot.workspaceRoot);
  const target = sandboxPolicy.resolve(
    write.path,
    snapshot.workspaceRoot,
    session.id,
    toolId,
  );
  const withinScope = (candidate: string) =>
    snapshot.writeScope!.some((scope) => {
      const allowed = path.resolve(snapshot.workspaceRoot, scope);
      return candidate === allowed || candidate.startsWith(allowed + path.sep);
    });
  if (
    !withinScope(path.resolve(snapshot.workspaceRoot, write.path)) ||
    !withinScope(target)
  ) {
    throw new AgentPermissionError(
      `File ${write.path} is outside the specialist writeScope.`,
    );
  }
  assertInheritedPermission(snapshot, toolId, write.path);
  assertInheritedPermission(
    snapshot,
    toolId,
    path.relative(snapshot.workspaceRoot, target).split(path.sep).join("/"),
  );
  if (
    toolId === "edit" &&
    typeof write.content !== "string" &&
    write.patch?.includes("*** Begin Patch")
  ) {
    const hunks = parseApplyPatchEnvelope(write.patch);
    const hunk = hunks[0];
    if (
      hunks.length !== 1 ||
      parse(relativePathSchema, hunk.path) !== write.path ||
      (hunk.type === "update" &&
        hunk.movePath &&
        parse(relativePathSchema, hunk.movePath) !== write.path)
    ) {
      throw new AgentPermissionError(
        "Specialist edit must affect exactly its scoped path, without moves.",
      );
    }
    if (hunk.type === "delete") {
      if (!snapshot.capabilities.includes("file.delete"))
        throw new AgentPermissionError(
          "Deleting through edit requires file.delete capability.",
        );
      assertInheritedPermission(snapshot, "file.delete", write.path);
    }
  }
}
