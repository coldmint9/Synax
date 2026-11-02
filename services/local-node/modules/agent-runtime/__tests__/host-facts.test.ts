import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureHostFacts,
  hostFactsEnabled,
  parseToolVersion,
  probeHostFacts,
  readHostFacts,
  resetHostFacts,
  resolveOnPath,
  type HostProbeRunner,
} from "../host-facts.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  resetHostFacts();
  for (const dir of temporaryDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A PATH directory holding executable stubs, so no real toolchain is probed. */
function binDir(...commands: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-facts-"));
  temporaryDirs.push(dir);
  for (const command of commands) {
    const file = path.join(dir, command);
    fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

it("parses the version token each tool actually prints", () => {
  expect(
    parseToolVersion(
      "java",
      'openjdk version "21.0.2" 2024-01-16\nOpenJDK Runtime Environment (build 21.0.2+13-58)',
    ),
  ).toBe("21.0.2");
  expect(parseToolVersion("mvn", "Apache Maven 3.9.16 (2bdd9fddda4b)")).toBe(
    "3.9.16",
  );
  expect(parseToolVersion("gradle", "\nWelcome to Gradle 8.10.2!\n")).toBe(
    "8.10.2",
  );
  expect(parseToolVersion("node", "v22.23.2\n")).toBe("22.23.2");
  expect(parseToolVersion("go", "go version go1.23.1 darwin/arm64")).toBe(
    "1.23.1",
  );
  expect(
    parseToolVersion(
      "bash",
      "GNU bash, version 3.2.57(1)-release (arm64-apple-darwin26)",
    ),
  ).toBe("3.2.57");
  // Unknown shapes keep the first line so a probe never reports a bogus number.
  expect(parseToolVersion("docker", "\n  Docker version 29.7.2  \n")).toBe(
    "Docker version 29.7.2",
  );
  expect(parseToolVersion("java", "")).toBeNull();
  // A failing launcher must not masquerade as a version...
  expect(
    parseToolVersion(
      "java",
      "The operation couldn't be completed. Unable to locate a Java Runtime.",
      1,
    ),
  ).toBeNull();
  // ...while a recognized banner still reports the tool's own version.
  expect(parseToolVersion("mvn", "Apache Maven 3.9.16\n[ERROR] JAVA_HOME", 1)).toBe(
    "3.9.16",
  );
});

it("resolves commands from PATH the way the agent's shell does", () => {
  const dir = binDir("node");
  fs.writeFileSync(path.join(dir, "not-executable"), "text");
  expect(resolveOnPath("node", { PATH: dir }, "linux")).toBe(
    path.join(dir, "node"),
  );
  expect(resolveOnPath("not-executable", { PATH: dir }, "linux")).toBeNull();
  expect(resolveOnPath("missing", { PATH: dir }, "linux")).toBeNull();
  expect(resolveOnPath("node", { PATH: "" }, "linux")).toBeNull();
});

it("probes installed tools, leaves missing ones null, and drops unrelated env", async () => {
  const dir = binDir("node", "java");
  const calls: string[] = [];
  const facts = await probeHostFacts({
    env: { PATH: dir, JAVA_HOME: "/opt/jdk", AWS_SECRET_ACCESS_KEY: "secret" },
    platform: "linux",
    now: () => 7,
    run: async (command, args) => {
      const name = path.basename(command);
      calls.push(`${name} ${args.join(" ")}`);
      return {
        status: 0,
        timedOut: false,
        output: name === "java" ? 'openjdk version "21.0.2"' : "v22.23.2",
      };
    },
  });
  expect(facts.probedAt).toBe(7);
  expect(calls.sort()).toEqual(["java -version", "node --version"]);
  expect(facts.tools.java).toEqual({
    version: "21.0.2",
    path: path.join(dir, "java"),
  });
  expect(facts.tools.node).toEqual({
    version: "22.23.2",
    path: path.join(dir, "node"),
  });
  expect(facts.tools.mvn).toBeNull();
  // Stable order keeps the rendered reminder identical across probes.
  expect(Object.keys(facts.tools)[0]).toBe("java");
  expect(facts.env).toEqual({ JAVA_HOME: "/opt/jdk" });
});

it("shares one probe between concurrent callers and refreshes it after the TTL", async () => {
  const dir = binDir("node");
  let probes = 0;
  let clock = 1_000;
  const options = () => ({
    env: { PATH: dir },
    platform: "linux" as NodeJS.Platform,
    now: () => clock,
    run: (async () => {
      probes += 1;
      return { status: 0, timedOut: false, output: "v22.23.2" };
    }) as HostProbeRunner,
  });
  const [first, second] = await Promise.all([
    ensureHostFacts(options()),
    ensureHostFacts(options()),
  ]);
  expect(probes).toBe(1);
  expect(second).toBe(first);
  expect(readHostFacts()).toBe(first);
  clock += 60_000;
  expect(await ensureHostFacts(options())).toBe(first);
  expect(probes).toBe(1);
  clock += 10 * 60_000;
  await ensureHostFacts(options());
  expect(probes).toBe(2);
});

it("never spawns probes under the test environment without an injected snapshot", async () => {
  expect(hostFactsEnabled({ NODE_ENV: "test" })).toBe(false);
  expect(
    await ensureHostFacts({
      env: { NODE_ENV: "test" },
      run: async () => {
        throw new Error("Version probes must not run in test suites.");
      },
    }),
  ).toBeNull();
});
