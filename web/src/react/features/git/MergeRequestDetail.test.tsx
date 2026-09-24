import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../lib/api/gitMr", () => ({
  gitMrApi: {
    get: vi.fn(),
    files: vi.fn(),
    proposals: vi.fn(),
    action: vi.fn(),
    file: vi.fn(),
    saveFile: vi.fn(),
  },
}));
vi.mock("../../components/file-viewer/FileViewerDialog", () => ({
  FileViewerDialog: ({ file, onSave }: any) => (
    <div role="dialog">
      <span>{file.path}</span>
      <button
        onClick={() =>
          onSave({
            expectedRevision: file.revision,
            content: "draft",
            resolve: false,
          })
        }
      >
        保存草稿
      </button>
      <span data-testid="file-revision">{file.revision}</span>
      <button
        onClick={() =>
          onSave({
            expectedRevision: file.revision,
            content: "resolved",
            resolve: true,
          })
        }
      >
        保存并解决
      </button>
    </div>
  ),
}));
import { gitMrApi } from "../../../lib/api/gitMr";
import { AppError } from "../../../lib/appError";
import { MergeRequestDetail } from "./MergeRequestDetail";
const request = {
  id: "mr",
  projectId: "p",
  title: "Merge feature",
  target: "master",
  targetOid: "old-target",
  strategy: "merge_commit" as const,
  steps: [
    { branch: "feature/a", oid: "source-oid", status: "completed" as const },
  ],
  status: "ready" as const,
  version: 4,
  currentStep: 1,
  candidateOid: "new-target",
  candidateTree: "tree",
  repository: "/repo",
  commonDir: "/repo/.git",
  createdAt: "2026-09-23",
  updatedAt: "2026-09-23",
  checks: [],
  checkResults: [],
  autoFinalize: false,
  allowCheckedOutTarget: false,
  events: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitMrApi.get).mockResolvedValue(request);
  vi.mocked(gitMrApi.files).mockResolvedValue([]);
  vi.mocked(gitMrApi.proposals).mockResolvedValue([]);
});
const mount = () =>
  render(
    <MemoryRouter>
      <MergeRequestDetail projectId="p" mrId="mr" />
    </MemoryRouter>,
  );
describe("MR detail actions", () => {
  it("shows the manual finalize path without offering an unconfigured check", async () => {
    mount();
    expect(
      await screen.findByRole("button", { name: "更新本地目标" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "运行检查" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "未配置验证检查。请审阅候选变更，确认后可直接更新本地目标。",
      ),
    ).toBeInTheDocument();
  });
  it("requires explicit local target confirmation and refreshes stale versions", async () => {
    vi.mocked(gitMrApi.action).mockRejectedValue(
      new AppError("MR changed; refresh and retry.", {
        level: "business",
        code: "STALE_VERSION",
        statusCode: 409,
      }),
    );
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "更新本地目标" }),
    );
    expect(gitMrApi.action).not.toHaveBeenCalled();
    vi.mocked(gitMrApi.get).mockResolvedValue({ ...request, version: 5 });
    fireEvent.click(
      screen.getByRole("button", { name: "确认更新本地 master" }),
    );
    await waitFor(() =>
      expect(gitMrApi.action).toHaveBeenCalledWith("p", "mr", "finalize", 4),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "请确认刷新后的状态再重试",
    );
    await waitFor(() => expect(screen.getByText(/v5/)).toBeInTheDocument());
  });
  it("explains an unconfigured check without suggesting a retry", async () => {
    vi.mocked(gitMrApi.get).mockResolvedValue({
      ...request,
      checks: [
        { id: "test", executable: "npm", args: ["test"], timeoutMs: 300000 },
      ],
    });
    vi.mocked(gitMrApi.action).mockRejectedValue(
      new AppError(
        "No verification commands configured. Manual finalize remains available.",
        {
          level: "business",
          code: "NO_CHECKS",
          statusCode: 400,
        },
      ),
    );
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "运行检查" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "未配置验证检查。请审阅候选变更，确认后可直接更新本地目标。",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("重试");
  });
  it("blocks continuation until a real conflict has been saved and refreshed", async () => {
    vi.mocked(gitMrApi.get).mockResolvedValue({
      ...request,
      status: "conflicted",
      currentStep: 0,
    });
    const summary = {
      id: "file",
      path: "src/example.ts",
      status: "U",
      conflicted: true,
    };
    const file = {
      ...summary,
      kind: "text" as const,
      base: "base",
      target: "target",
      source: "source",
      result: "unresolved",
      revision: "rev1",
      baseExists: true,
      targetExists: true,
      sourceExists: true,
    };
    vi.mocked(gitMrApi.files).mockResolvedValue([summary]);
    vi.mocked(gitMrApi.file).mockResolvedValue(file);
    vi.mocked(gitMrApi.saveFile).mockResolvedValue({
      ...file,
      conflicted: false,
      result: "resolved",
      revision: "rev2",
    });
    mount();
    expect(
      await screen.findByRole("button", { name: "还有 1 个冲突待解决" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "src/example.ts 冲突" }),
    );
    await screen.findByRole("dialog");
    vi.mocked(gitMrApi.files).mockResolvedValue([
      { ...summary, conflicted: false },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "保存并解决" }));
    await waitFor(() =>
      expect(gitMrApi.saveFile).toHaveBeenCalledWith("p", "mr", "file", {
        expectedRevision: "rev1",
        content: "resolved",
        resolve: true,
      }),
    );
    expect(
      await screen.findByRole("button", { name: "继续合并" }),
    ).toBeEnabled();
  });
});

it.each(["failed", "interrupted"] as const)(
  "offers versioned recovery for %s runs and explains rejection",
  async (status) => {
    vi.mocked(gitMrApi.get).mockResolvedValue({ ...request, status });
    vi.mocked(gitMrApi.action).mockRejectedValue(
      new Error("Candidate worktree diverged from the journal"),
    );
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "核验并恢复" }));
    await waitFor(() =>
      expect(gitMrApi.action).toHaveBeenCalledWith("p", "mr", "resume", 4),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Candidate worktree diverged",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "请确认刷新后的状态再重试",
    );
  },
);
it("keeps check failures on the check rerun path", async () => {
  vi.mocked(gitMrApi.get).mockResolvedValue({
    ...request,
    status: "check_failed",
    checks: [
      { id: "test", executable: "npm", args: ["test"], timeoutMs: 300000 },
    ],
  });
  mount();
  expect(await screen.findByRole("button", { name: "运行检查" })).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "核验并恢复" }),
  ).not.toBeInTheDocument();
});
it("preserves a successfully saved draft and new revision when status refresh fails", async () => {
  vi.mocked(gitMrApi.get).mockResolvedValue({
    ...request,
    status: "conflicted",
    currentStep: 0,
  });
  const file = {
    id: "file",
    path: "src/example.ts",
    status: "U",
    conflicted: true,
    kind: "text" as const,
    base: "base",
    target: "target",
    source: "source",
    result: "unresolved",
    revision: "rev1",
    baseExists: true,
    targetExists: true,
    sourceExists: true,
  };
  vi.mocked(gitMrApi.files).mockResolvedValue([file]);
  vi.mocked(gitMrApi.file).mockResolvedValue(file);
  vi.mocked(gitMrApi.saveFile).mockResolvedValue({
    ...file,
    result: "draft",
    revision: "rev2",
  });
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "src/example.ts 冲突" }),
  );
  await screen.findByRole("dialog");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled(),
  );
  vi.mocked(gitMrApi.get).mockRejectedValue(
    new Error("temporarily unavailable"),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "文件已保存，但状态刷新失败",
  );
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByTestId("file-revision")).toHaveTextContent("rev2");
});
