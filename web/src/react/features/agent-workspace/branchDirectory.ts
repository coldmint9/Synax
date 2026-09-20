import type { SessionGitBranches } from "../../../lib/api/agentRuntime";

type Branch = SessionGitBranches["branches"][number];
export type BranchDirectoryEntry =
  | { kind: "branch"; label: string; branch: Branch }
  | {
      kind: "directory";
      label: string;
      path: string;
      children: BranchDirectoryEntry[];
      current: boolean;
    };

export function groupBranchDirectories(
  branches: Branch[],
): BranchDirectoryEntry[] {
  const root: BranchDirectoryEntry[] = [];
  for (const branch of branches) {
    const parts = branch.name.split("/");
    let entries = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const path = parts.slice(0, index + 1).join("/");
      let directory = entries.find(
        (entry) => entry.kind === "directory" && entry.path === path,
      );
      if (!directory || directory.kind !== "directory") {
        directory = {
          kind: "directory",
          label: parts[index],
          path,
          children: [],
          current: false,
        };
        entries.push(directory);
      }
      directory.current ||= branch.current;
      entries = directory.children;
    }
    entries.push({ kind: "branch", label: parts[parts.length - 1], branch });
  }
  function sort(entries: BranchDirectoryEntry[]) {
    entries.sort((a, b) =>
      a.kind !== b.kind
        ? a.kind === "directory"
          ? -1
          : 1
        : a.label.localeCompare(b.label),
    );
    for (const entry of entries)
      if (entry.kind === "directory") sort(entry.children);
  }
  sort(root);
  return root;
}
