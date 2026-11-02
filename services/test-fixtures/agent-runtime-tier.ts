import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Split agent-runtime tests by whether they need the real Rust runtime.
 *
 * A file belongs to the runtime tier when it boots the supervisor fixture
 * directly or through the shared agent-runtime fixtures. Every other file is a
 * unit test that only needs Vitest. Classification reads the sources at config
 * load time, so a new test file can never silently fall into the wrong tier. */

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(fixtureDirectory, "../..");
export const agentRuntimeDirectory = path.join(
  projectRoot,
  "services/local-node/modules/agent-runtime",
);

const TEST_FILE = /\.(test|spec)\.tsx?$/;
// The supervisor fixture, or the shared agent-runtime fixtures that boot it.
const RUNTIME_FIXTURE_IMPORT =
  /from\s+["'][^"']*(?:test-fixtures\/rust-runtime|agent-runtime-fixtures)[^"']*["']/;
// Existing naming for suites that drive real processes or storage.
const RUNTIME_NAME = /\.(integration|runtime)\.(test|spec)\.tsx?$/;

function listTestFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listTestFiles(absolute));
    else if (TEST_FILE.test(entry.name)) found.push(absolute);
  }
  return found;
}

/** Project-root relative paths, so `include` lists stay portable. */
function relative(absolute: string): string {
  return path.relative(projectRoot, absolute).split(path.sep).join("/");
}

export interface AgentRuntimeTiers {
  runtime: string[];
  unit: string[];
}

export function classifyAgentRuntimeTests(): AgentRuntimeTiers {
  const runtime: string[] = [];
  const unit: string[] = [];
  for (const absolute of listTestFiles(agentRuntimeDirectory).sort()) {
    const source = readFileSync(absolute, "utf8");
    const needsRuntime = RUNTIME_NAME.test(absolute) || RUNTIME_FIXTURE_IMPORT.test(source);
    (needsRuntime ? runtime : unit).push(relative(absolute));
  }
  return { runtime, unit };
}
