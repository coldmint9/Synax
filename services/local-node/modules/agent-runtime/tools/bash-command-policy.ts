export type BashCommandRisk = "read" | "write";

export interface BashInvocation {
  command: string;
  subcommand: string | null;
  /** Permission pattern, e.g. `rg` or `git:diff`. */
  pattern: string;
  risk: BashCommandRisk;
}

const READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "rg",
  "grep",
  "find",
  "ls",
  "wc",
  "sort",
  "uniq",
  "tr",
  "cut",
  "awk",
  "echo",
  "printf",
  "basename",
  "dirname",
  "realpath",
  "file",
  "stat",
  "du",
  "date",
  "env",
  "which",
  "pwd",
  "id",
  "uname",
]);

const WRITE_COMMANDS = new Set([
  "rm",
  "mv",
  "cp",
  "mkdir",
  "rmdir",
  "touch",
  "chmod",
  "chown",
  "ln",
  "sed",
  "tee",
  "xargs",
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "bun",
  "node",
  "deno",
  "python",
  "python3",
  "ruby",
  "go",
  "cargo",
  "rustc",
  "make",
  "cmake",
  "gradle",
  "mvn",
  "curl",
  "wget",
  "docker",
  "podman",
  "kubectl",
  "helm",
  "ssh",
  "scp",
  "rsync",
]);

const READ_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set([
    "diff",
    "log",
    "show",
    "status",
    "branch",
    "blame",
    "ls-files",
    "ls-tree",
    "rev-parse",
    "rev-list",
    "describe",
    "shortlog",
    "tag",
  ]),
  docker: new Set([
    "ps",
    "images",
    "inspect",
    "logs",
    "top",
    "version",
    "info",
  ]),
  npm: new Set(["view", "ls", "list", "outdated", "doctor", "prefix", "root"]),
  npx: new Set(["--version"]),
  kubectl: new Set([
    "get",
    "describe",
    "logs",
    "top",
    "version",
    "cluster-info",
    "api-resources",
    "api-versions",
  ]),
};

const WRITE_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set([
    "add",
    "commit",
    "push",
    "pull",
    "fetch",
    "merge",
    "rebase",
    "reset",
    "clean",
    "checkout",
    "switch",
    "cherry-pick",
    "revert",
    "apply",
    "am",
    "clone",
    "init",
    "remote",
  ]),
  docker: new Set([
    "run",
    "build",
    "exec",
    "cp",
    "rm",
    "rmi",
    "pull",
    "push",
    "compose",
    "create",
    "start",
    "stop",
  ]),
  npm: new Set([
    "install",
    "ci",
    "run",
    "exec",
    "publish",
    "uninstall",
    "update",
    "test",
    "start",
    "build",
  ]),
  npx: new Set(["create", "exec"]),
  kubectl: new Set([
    "apply",
    "delete",
    "create",
    "patch",
    "replace",
    "scale",
    "rollout",
    "exec",
    "port-forward",
  ]),
};

const SUBCOMMAND_COMMANDS = new Set([
  "git",
  "docker",
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "kubectl",
  "helm",
  "go",
]);

/**
 * Split a shell command string on top-level pipes, chain operators, and
 * semicolons while respecting single/double quote boundaries.
 */
export function splitBashCommands(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"') inDouble = false;
      continue;
    }

    if (ch === "'") {
      current += ch;
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      current += ch;
      inDouble = true;
      continue;
    }

    if (ch === "|" && i + 1 < command.length && command[i + 1] === "|") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i++;
      continue;
    }

    if (ch === "|") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }

    if (ch === "&" && i + 1 < command.length && command[i + 1] === "&") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i++;
      continue;
    }

    if (ch === ";") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

function normalizeCommandName(token: string): string {
  let cmd = token;
  const lastSlash = cmd.lastIndexOf("/");
  if (lastSlash >= 0) cmd = cmd.substring(lastSlash + 1);
  return cmd;
}

function extractSubcommand(
  command: string,
  tokens: string[],
  commandIndex: number,
): string | null {
  if (!SUBCOMMAND_COMMANDS.has(command)) return null;

  let idx = commandIndex + 1;
  while (idx < tokens.length && tokens[idx].startsWith("-")) {
    idx++;
  }
  if (idx >= tokens.length) return null;
  return tokens[idx];
}

function classifyInvocation(
  command: string,
  subcommand: string | null,
): BashCommandRisk {
  if (command === "git" && subcommand === "remote") return "write";
  if (command === "git" && subcommand === "config") return "write";
  if (command === "git" && subcommand === "stash") return "write";

  if (subcommand) {
    const readSubs = READ_SUBCOMMANDS[command];
    if (readSubs?.has(subcommand)) return "read";
    const writeSubs = WRITE_SUBCOMMANDS[command];
    if (writeSubs?.has(subcommand)) return "write";
  }

  if (READ_COMMANDS.has(command)) return "read";
  if (WRITE_COMMANDS.has(command)) return "write";
  if (SUBCOMMAND_COMMANDS.has(command)) return subcommand ? "write" : "read";
  return "write";
}

function parseSegment(segment: string): BashInvocation | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) {
    idx++;
  }
  if (idx >= tokens.length) return null;

  const command = normalizeCommandName(tokens[idx]);
  const subcommand = extractSubcommand(command, tokens, idx);
  const risk = classifyInvocation(command, subcommand);
  const pattern = subcommand ? `${command}:${subcommand}` : command;

  return { command, subcommand, pattern, risk };
}

export function parseBashInvocations(command: string): BashInvocation[] {
  return splitBashCommands(command)
    .map(parseSegment)
    .filter((invocation): invocation is BashInvocation => invocation !== null);
}

/** Git operations that must be represented by the persistent merge task card.
 * Read-only inspection such as status, diff and log remains available through bash. */
export type GitMergeWorkflowSubcommand = "merge" | "rebase" | "cherry-pick" | "revert" | "am";

export function gitMergeWorkflowSubcommands(command: string): Set<GitMergeWorkflowSubcommand> {
  const found = new Set<GitMergeWorkflowSubcommand>();
  for (const segment of splitBashCommands(command)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const gitIndex = tokens.findIndex((token) => normalizeCommandName(token) === "git");
    if (gitIndex < 0) continue;
    let index = gitIndex + 1;
    while (index < tokens.length) {
      const token = tokens[index];
      if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) { index += 2; continue; }
      if (token.startsWith("-")) { index += 1; continue; }
      if (["merge", "rebase", "cherry-pick", "revert", "am"].includes(token))
        found.add(token as GitMergeWorkflowSubcommand);
      break;
    }
  }
  return found;
}

export function bashPermissionPatterns(command: string): string[] {
  const invocations = parseBashInvocations(command);
  if (invocations.length === 0) return ["*"];
  const patterns = new Set<string>();
  for (const invocation of invocations) {
    patterns.add(invocation.pattern);
    patterns.add(invocation.risk);
  }
  patterns.add("*");
  return [...patterns];
}

export function bashPermissionSummary(command: string): string {
  const invocations = parseBashInvocations(command);
  if (invocations.length === 0) return "*";
  return invocations.map((invocation) => invocation.pattern).join(" | ");
}

/** Git global options whose value is the next token, so the subcommand follows it. */
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
]);

/** Stash subcommands that only read the stash: safe for diagnosis. */
const STASH_READ_SUBCOMMANDS = new Set(["list", "show"]);

const HELP_FLAGS = new Set(["-h", "--help"]);

/** Git subcommands that can move, overwrite or discard uncommitted work. */
export type GitDiscardSubcommand = "stash" | "reset" | "clean" | "restore";

/**
 * Destructive git subcommands used by a command: stash push/pop/apply/drop/clear,
 * reset --hard/--keep/--merge, a forced clean, or restore. Read-only forms such
 * as `git stash list` and `git status` are absent, so diagnosing a workspace
 * never needs a user instruction while destructive changes still do. Keeping
 * the subcommand identity lets an instruction unlock exactly what it named.
 */
export function discardedGitSubcommands(command: string): Set<GitDiscardSubcommand> {
  const found = new Set<GitDiscardSubcommand>();
  for (const segment of splitBashCommands(command)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const gitIndex = tokens.findIndex((token) => normalizeCommandName(token) === "git");
    if (gitIndex < 0) continue;

    let index = gitIndex + 1;
    while (index < tokens.length && tokens[index].startsWith("-"))
      index += GIT_GLOBAL_OPTIONS_WITH_VALUE.has(tokens[index]) ? 2 : 1;
    const subcommand = tokens[index];
    if (!subcommand) continue;
    const args = tokens.slice(index + 1);
    // Help output reads nothing and writes nothing.
    if (args.length > 0 && args.every((arg) => HELP_FLAGS.has(arg))) continue;

    if (subcommand === "stash") {
      // A bare `git stash` defaults to push, so only an explicit read action is safe.
      const action = args.find((arg) => !arg.startsWith("-"));
      if (!action || !STASH_READ_SUBCOMMANDS.has(action)) found.add("stash");
    } else if (subcommand === "reset") {
      // Index-only resets keep every working-tree byte; they remain allowed.
      if (args.some((arg) => ["--hard", "--keep", "--merge"].includes(arg))) found.add("reset");
    } else if (subcommand === "clean") {
      if (args.some((arg) => arg === "--dry-run" || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(arg))) continue;
      if (args.some((arg) => arg === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg))) found.add("clean");
    } else if (subcommand === "restore") {
      found.add("restore");
    }
  }
  return found;
}

export function gitCommandDiscardsLocalChanges(command: string): boolean {
  return discardedGitSubcommands(command).size > 0;
}

/** Detect actual background operators, not quoted ampersands or fd redirects. */
export function hasBackgroundBashOperator(command: string): boolean {
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (
      char === "&" &&
      command[i + 1] !== "&" &&
      command[i + 1] !== ">" &&
      !["&", ">", "|"].includes(command[i - 1])
    )
      return true;
  }
  return false;
}
