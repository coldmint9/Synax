import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  countWorkspaceGitFiles,
  indexWorkspaceGitCounts,
  WorkspaceGitCountBadges,
} from "../workspaceGitCountBadges";

const files = [
  { path: "src/app.ts", untracked: false },
  { path: "src/new.ts", untracked: true },
  { path: "README.md", untracked: false },
];

it("counts tracked changes and untracked files separately for a directory", () => {
  expect(countWorkspaceGitFiles(files, "src")).toEqual({ uncommitted: 1, untracked: 1 });
  expect(countWorkspaceGitFiles(files)).toEqual({ uncommitted: 2, untracked: 1 });
});

it('aggregates nested files without counting sibling prefixes or literal backslashes as directories', () => {
  const counts = indexWorkspaceGitCounts([
    ...files, { path: 'src/deep/child.ts', untracked: true }, { path: 'src-other/app.ts', untracked: false },
    { path: 'src\\literal.ts', untracked: false },
  ]);
  expect(counts.get('')).toEqual({ uncommitted: 4, untracked: 2 });
  expect(counts.get('src')).toEqual({ uncommitted: 1, untracked: 2 });
  expect(counts.get('src/deep')).toEqual({ uncommitted: 0, untracked: 1 });
});

it("renders separate orange and gray count badges", () => {
  render(<WorkspaceGitCountBadges counts={{ uncommitted: 4, untracked: 2 }} />);
  expect(screen.getByTitle("未提交 4 个文件")).toHaveClass("workspace-git-count-badge--uncommitted");
  expect(screen.getByTitle("未跟踪 2 个文件")).toHaveClass("workspace-git-count-badge--untracked");
});
