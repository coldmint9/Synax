import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProjectBuildInstructions,
  findMavenProjectRoot,
  MAVEN_BUILD_OPTIMIZATION_INSTRUCTIONS,
} from "../project-build-instructions.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-maven-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Maven project prompt guidance", () => {
  it("detects pom.xml in the bound project", () => {
    const root = tempDir();
    const nested = path.join(root, "src", "main");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, "pom.xml"), "<project />");

    expect(findMavenProjectRoot(nested)).toBe(fs.realpathSync(root));
    expect(buildProjectBuildInstructions(nested)).toBe(
      MAVEN_BUILD_OPTIMIZATION_INSTRUCTIONS,
    );
  });

  it("detects an unversioned root and refreshes when its pom.xml is removed", () => {
    const root = tempDir();
    expect(buildProjectBuildInstructions(root)).toBeNull();
    fs.writeFileSync(path.join(root, "pom.xml"), "<project />");
    expect(buildProjectBuildInstructions(root)).toContain("Maven build optimization");
    fs.unlinkSync(path.join(root, "pom.xml"));
    expect(buildProjectBuildInstructions(root)).toBeNull();
  });

  it("does not inherit a pom.xml outside an unversioned workspace", () => {
    const parent = tempDir();
    fs.writeFileSync(path.join(parent, "pom.xml"), "<project />");
    const root = path.join(parent, "other");
    fs.mkdirSync(root);
    expect(buildProjectBuildInstructions(root)).toBeNull();
  });

  it("supports worktree git files and the nearest Maven module", () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /unused");
    fs.writeFileSync(path.join(root, "pom.xml"), "<project />");
    const module = path.join(root, "module");
    const source = path.join(module, "src");
    fs.mkdirSync(source, { recursive: true });
    expect(findMavenProjectRoot(source)).toBe(fs.realpathSync(root));
    fs.writeFileSync(path.join(module, "pom.xml"), "<project />");
    expect(findMavenProjectRoot(source)).toBe(fs.realpathSync(module));
  });

  it("ignores missing roots, non-file markers and sibling projects", () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, "pom.xml"));
    fs.mkdirSync(path.join(root, "sibling"));
    fs.writeFileSync(path.join(root, "sibling", "pom.xml"), "<project />");
    expect(buildProjectBuildInstructions(root)).toBeNull();
    expect(buildProjectBuildInstructions(path.join(root, "missing"))).toBeNull();
  });

  it("does not cross a repository boundary for an unrelated parent pom.xml", () => {
    const parent = tempDir();
    const repo = path.join(parent, "repo");
    const nested = path.join(repo, "module");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(parent, "pom.xml"), "<project />");
    fs.writeFileSync(path.join(repo, ".git"), "gitdir: /tmp/other");

    expect(findMavenProjectRoot(nested)).toBeNull();
    expect(buildProjectBuildInstructions(nested)).toBeNull();
  });
});
