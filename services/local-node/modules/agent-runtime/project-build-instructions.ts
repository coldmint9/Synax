import fs from "node:fs";
import path from "node:path";

/**
 * Maven guidance is kept separate from repository-owned rules so it can be
 * added only when the bound workspace actually contains a Maven project.
 */
export const MAVEN_BUILD_OPTIMIZATION_INSTRUCTIONS = [
  "## Maven build optimization",
  "The bound workspace contains a Maven project (`pom.xml`).",
  "- Inspect the root pom.xml, modules, profiles and relevant plugins before choosing a lifecycle command.",
  "- Prefer the repository Maven Wrapper (`./mvnw` or `mvnw.cmd`) when present; otherwise use `mvn`.",
  "- Prefer incremental, targeted verification from the reactor root, e.g. `mvn -B -ntp -pl <module> -am test` or `verify`; omit -pl/-am for a single module. Use the wrapper in these examples when available. Avoid `clean` unless stale outputs or the task requires it.",
  "- Use `-T 1C` only when the module graph and plugins are safe for parallel execution; do not trade away deterministic results for speed.",
  "- Use `-DskipTests` only when tests are intentionally deferred and state that omission; never use it to hide a failure.",
  "- Reuse the local dependency cache; do not default to -U, offline mode, install or deploy. Use them only when dependency freshness, offline availability or the requested lifecycle requires it. Preserve profiles, properties and dependency versions unless the task requires changing them; keep generated target/ output out of commits.",
  "- Report the exact Maven command and its result, including the selected module, profile and lifecycle phase.",
].join("\n");

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Find a Maven marker in the bound project or one of its project ancestors.
 * Stop at the repository boundary so a parent directory containing an
 * unrelated pom.xml cannot affect the prompt. Without a repository boundary,
 * only the bound directory supplies evidence.
 */
export function findMavenProjectRoot(workDir: string): string | null {
  let cwd: string;
  try {
    cwd = fs.realpathSync(workDir);
    if (!fs.statSync(cwd).isDirectory()) return null;
  } catch {
    return null;
  }
  if (isRegularFile(path.join(cwd, "pom.xml"))) return cwd;
  let candidate: string | null = null;
  for (let current = cwd; ;) {
    if (fs.existsSync(path.join(current, ".git"))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
    if (!candidate && isRegularFile(path.join(current, "pom.xml"))) candidate = current;
  }
}

export function buildProjectBuildInstructions(workDir: string): string | null {
  return findMavenProjectRoot(workDir)
    ? MAVEN_BUILD_OPTIMIZATION_INSTRUCTIONS
    : null;
}
