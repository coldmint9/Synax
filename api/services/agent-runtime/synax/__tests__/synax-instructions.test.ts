import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadProjectRulesSection,
  stripPromptBloat,
  truncateForPrompt,
} from "../synax-instructions.js";

describe("stripPromptBloat", () => {
  it("removes HeroUI docs index block", () => {
    const input = [
      "# Project",
      "<!-- HEROUI-REACT-AGENTS-MD-START -->",
      "huge index content",
      "<!-- HEROUI-REACT-AGENTS-MD-END -->",
      "## Architecture",
      "Keep this",
    ].join("\n");

    const output = stripPromptBloat(input);
    expect(output).not.toContain("HEROUI-REACT-AGENTS-MD");
    expect(output).toContain("## Architecture");
    expect(output).toContain("Keep this");
  });
});

describe("truncateForPrompt", () => {
  it("appends truncation marker when over budget", () => {
    const output = truncateForPrompt("x".repeat(100), 50);
    expect(output.length).toBeLessThan(100);
    expect(output).toContain("[...truncated for context budget...]");
  });
  it("respects even a budget shorter than the truncation marker", () => {
    for (const budget of [0, 1, 20, 50])
      expect(
        truncateForPrompt("x".repeat(100), budget).length,
      ).toBeLessThanOrEqual(budget);
  });
});

describe("bounded project rule inheritance", () => {
  let dir: string;
  let root: string;
  const write = (name: string, text: string) => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-rule-chain-"));
    root = path.join(dir, "repo");
    fs.mkdirSync(path.join(root, "services", "auth"), { recursive: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(["directory", "worktree-file"])(
    "merges root to cwd in a %s checkout with explicit precedence and sources",
    (kind) => {
      if (kind === "directory") fs.mkdirSync(path.join(root, ".git"));
      else write(".git", "gitdir: /another/location/worktrees/test");
      fs.writeFileSync(path.join(dir, "AGENTS.md"), "OUTSIDE_PARENT");
      write("CLAUDE.md", "ROOT_CLAUDE");
      write("AGENTS.md", "ROOT_AGENTS");
      write("SYNAX.md", "DEPRECATED_SYNAX");
      write("SYNAX.local.md", "DEPRECATED_LOCAL");
      write("services/AGENTS.md", "SERVICES");
      write("services/auth/AGENTS.md", "AUTH");
      write("services/auth/child/AGENTS.md", "DESCENDANT");
      write("reference/AGENTS.md", "REFERENCE");
      const text = loadProjectRulesSection(
        path.join(root, "services", "auth"),
      )!;
      const values = ["ROOT_CLAUDE", "ROOT_AGENTS", "SERVICES", "AUTH"];
      for (let n = 1; n < values.length; n++)
        expect(text.indexOf(values[n])).toBeGreaterThan(
          text.indexOf(values[n - 1]),
        );
      expect(text).not.toMatch(
        /OUTSIDE_PARENT|DESCENDANT|REFERENCE|DEPRECATED_/,
      );
      expect(text).toContain('### "services/auth/AGENTS.md"');
      expect(text).toContain("Later rules take precedence");
    },
  );

  it("ignores deprecated SYNAX.md and SYNAX.local.md rule files", () => {
    fs.mkdirSync(path.join(root, ".git"));
    write("SYNAX.md", "SYNAX_RULES");
    write("SYNAX.local.md", "LOCAL_RULES");
    write("AGENTS.md", "AGENTS_RULES");
    const text = loadProjectRulesSection(root)!;
    expect(text).toContain("AGENTS_RULES");
    expect(text).not.toMatch(/SYNAX_RULES|LOCAL_RULES/);
    expect(text).not.toContain("SYNAX.md");
  });

  it("loads only cwd outside Git and orders CLAUDE.md before AGENTS.md", () => {
    write("SYNAX.md", "PARENT");
    write("services/CLAUDE.md", "CHILD_CLAUDE");
    write("services/AGENTS.md", "CHILD_AGENTS");
    const text = loadProjectRulesSection(path.join(root, "services"))!;
    expect(text).not.toContain("PARENT");
    expect(text.indexOf("CHILD_AGENTS")).toBeGreaterThan(
      text.indexOf("CHILD_CLAUDE"),
    );
  });

  it("rejects escaping and broken symlinks while allowing rules linked within the checkout", () => {
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(dir, "external.md"), "EXTERNAL_SECRET");
    fs.symlinkSync(path.join(dir, "external.md"), path.join(root, "AGENTS.md"));
    write("rules.md", "INTERNAL_RULE");
    fs.symlinkSync(path.join(root, "rules.md"), path.join(root, "CLAUDE.md"));
    fs.symlinkSync(
      path.join(root, "missing.md"),
      path.join(root, "services", "CLAUDE.md"),
    );
    const text = loadProjectRulesSection(path.join(root, "services"))!;
    expect(text).toContain("INTERNAL_RULE");
    expect(text).toContain("symlink outside the project rule root");
    expect(text).toContain("Rule unavailable: ENOENT");
    expect(text).not.toContain("EXTERNAL_SECRET");
  });

  it("reports unreadable sources and skips absent, empty, or deprecated files", () => {
    expect(loadProjectRulesSection(root)).toBeNull();
    write("CLAUDE.md", "");
    write("SYNAX.md", "IGNORED_DEPRECATED");
    write("AGENTS.md", "UNREADABLE");
    const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(
      (...args: Parameters<typeof read>) => {
        if (String(args[0]).endsWith("AGENTS.md"))
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        return read(...args);
      },
    );
    const text = loadProjectRulesSection(root)!;
    expect(text).toContain('### "AGENTS.md"');
    expect(text).toContain("Rule unavailable: EACCES");
    expect(text).not.toContain('### "CLAUDE.md"');
    expect(text).not.toContain("IGNORED_DEPRECATED");
  });

  it("caps individual files and prioritizes deeper rules under the total budget", () => {
    fs.mkdirSync(path.join(root, ".git"));
    for (const name of ["CLAUDE.md", "AGENTS.md"])
      write(name, "ROOT".repeat(5000));
    write("services/AGENTS.md", "DEEP".repeat(5000));
    write("services/CLAUDE.md", "KEEP_DEEP_CLAUDE");
    const text = loadProjectRulesSection(path.join(root, "services"))!;
    expect(text.length).toBeLessThanOrEqual(18000);
    expect(text).toContain("truncated for context budget");
    expect(text).toContain("KEEP_DEEP_CLAUDE");
    const tight = loadProjectRulesSection(path.join(root, "services"), {
      maxChars: 450,
    })!;
    expect(tight.length).toBeLessThanOrEqual(450);
    expect(tight).toContain('### "services/AGENTS.md"');
    expect(tight).not.toContain("ROOTROOT");
    expect(tight).toContain("lower-priority rules omitted");
  });
});
