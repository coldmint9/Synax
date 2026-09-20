import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCompatibleLocations,
  locationContains,
  locationKey,
  parseWslUncPath,
  physicalLocationKey,
  workspaceLocationHostPath,
  type WorkspaceLocation,
} from "../workspace-location.js";

const wsl = (
  pathValue: string,
  distribution = "Ubuntu",
): WorkspaceLocation => ({ kind: "wsl", distribution, path: pathValue });

describe("workspace locations", () => {
  it("maps WSL paths to internal UNC paths and parses them back", () => {
    const location = wsl("/home/mint/project with space", "Ubuntu 24.04");
    const hostPath = workspaceLocationHostPath(location);
    expect(hostPath).toBe(
      "\\\\wsl.localhost\\Ubuntu 24.04\\home\\mint\\project with space",
    );
    expect(parseWslUncPath(hostPath)).toEqual(location);
  });

  it("keeps distro identity case-insensitive and Linux paths case-sensitive", () => {
    expect(locationKey(wsl("/Repo", "Ubuntu"))).toBe(
      locationKey(wsl("/Repo", "ubuntu")),
    );
    expect(locationKey(wsl("/Repo"))).not.toBe(locationKey(wsl("/repo")));
  });

  it("recognizes /mnt drive paths as the same physical Windows directory", () => {
    expect(physicalLocationKey(wsl("/mnt/c/Users/Mint/Repo"))).toBe(
      physicalLocationKey({ kind: "host", path: "C:\\Users\\Mint\\Repo" }),
    );
  });

  it("uses POSIX containment for WSL and host containment for local paths", () => {
    expect(
      locationContains(wsl("/home/me/repo"), wsl("/home/me/repo/src")),
    ).toBe(true);
    expect(
      locationContains(wsl("/home/me/repo"), wsl("/home/me/repository")),
    ).toBe(false);
    const hostRoot: WorkspaceLocation = {
      kind: "host",
      path: path.resolve("/tmp/repo"),
    };
    expect(
      locationContains(hostRoot, {
        kind: "host",
        path: path.join(hostRoot.path, "src"),
      }),
    ).toBe(true);
  });

  it("rejects mixed host and WSL roots and different distributions", () => {
    expect(() =>
      assertCompatibleLocations([{ kind: "host", path: "/tmp/a" }, wsl("/a")]),
    ).toThrow(/same environment/i);
    expect(() =>
      assertCompatibleLocations([wsl("/a", "Ubuntu"), wsl("/b", "Debian")]),
    ).toThrow(/same WSL distribution/i);
  });
});
