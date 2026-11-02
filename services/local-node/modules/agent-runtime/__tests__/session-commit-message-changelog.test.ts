import { describe, expect, it } from "vitest";
import type {
  CommitMessageContext,
  CommitMessageFile,
} from "../session-commit-message-context.js";
import {
  MAX_BATCH_FILES,
  MAX_ENTRY_CHARS,
  MAX_SUMMARY_BULLETS,
  deterministicCommitTitle,
  groundedSummaryBullets,
  mergeBatchAnswers,
  parseChangelogEntries,
  planCommitMessageBatches,
  repeatsTitle,
  renderBatchPrompt,
  stripReasoning,
} from "../session-commit-message-changelog.js";

function file(
  path: string,
  overrides: Partial<CommitMessageFile> = {},
): CommitMessageFile {
  return {
    path,
    status: "M",
    additions: 2,
    deletions: 1,
    binary: false,
    patch: "+change",
    ...overrides,
  };
}

function context(files: CommitMessageFile[]): CommitMessageContext {
  return {
    projectId: "p1",
    branch: "main",
    stagedSummary: "",
    unstagedSummary: "",
    subjects: ["feat(ui): 上次提交"],
    files,
    totals: {
      files: files.length,
      additions: files.reduce((sum, item) => sum + item.additions, 0),
      deletions: files.reduce((sum, item) => sum + item.deletions, 0),
    },
  };
}

describe("commit message batches", () => {
  it("keeps a small commit in one batch and splits a large one", () => {
    const small = Array.from({ length: MAX_BATCH_FILES }, (_, index) =>
      file(`src/f${index}.ts`),
    );
    expect(planCommitMessageBatches(small)).toHaveLength(1);
    const large = Array.from({ length: MAX_BATCH_FILES * 3 }, (_, index) =>
      file(`src/f${index}.ts`, { additions: index }),
    );
    const batches = planCommitMessageBatches(large);
    expect(batches).toHaveLength(3);
    expect(batches.map((batch) => batch.files.length)).toEqual([
      MAX_BATCH_FILES,
      MAX_BATCH_FILES,
      MAX_BATCH_FILES,
    ]);
    expect(batches.map((batch) => batch.index)).toEqual([1, 2, 3]);
    // The largest change comes first, so the first batch describes what matters.
    expect(batches[0].files[0].additions).toBe(MAX_BATCH_FILES * 3 - 1);
  });
  it("asks for grouped summary bullets instead of one bullet per file", () => {
    const files = Array.from({ length: MAX_BATCH_FILES + 2 }, (_, index) =>
      file(`client/src/features/area-${index}/Panel${index}.tsx`),
    );
    const prompt = renderBatchPrompt(
      planCommitMessageBatches(files)[1],
      context(files),
      "en",
    );
    for (const leftover of [
      "Write a commit message in the conventional commit convention.",
      "Keep the title within 74 characters",
      "Use English language to answer.",
      "End commit title with issue number if you can get it from the branch name: main in parenthesis.",
      "Previous commit messages:",
      "feat(ui): 上次提交",
      "batch 2/2, 2 files",
      "write 2-6 bullets that summarize this change by theme",
      "Never write one bullet per file",
      "never turn the body into a file list",
      "never repeat the title as a bullet",
      "other batches are summarized separately",
    ])
      expect(prompt).toContain(leftover);
    // The second batch carries only the two files it owns.
    expect(prompt).toContain("Panel12.tsx");
    expect(prompt).toContain("Panel13.tsx");
    expect(prompt).not.toContain("Panel0.tsx");
    for (const leftover of ["{locale}", "{branch}", "{previousCommitMessages}", "{diff}"])
      expect(prompt).not.toContain(leftover);
    expect(prompt.length).toBeLessThan(20_000);
  });
  it("keeps a large commit prompt small per batch", () => {
    const files = Array.from({ length: 148 }, (_, index) =>
      file(`client/src/features/area-${index % 7}/Panel${index}.tsx`, {
        additions: index,
        patch: "+".concat("x".repeat(4_000)),
      }),
    );
    const batches = planCommitMessageBatches(files);
    expect(batches).toHaveLength(13);
    for (const batch of batches)
      expect(renderBatchPrompt(batch, context(files), "zh").length).toBeLessThan(
        20_000,
      );
  });
  it("states only git facts when the model cannot answer", () => {
    const files = [file("src/a.ts"), file("src/b.ts")];
    expect(deterministicCommitTitle(context(files), "en")).toBe(
      "chore(repo): update 2 files (+4 -2)",
    );
    expect(deterministicCommitTitle(context(files), "zh")).toBe(
      "chore(repo): 更新 2 个文件，+4 −2",
    );
  });
  it("summarizes a file set by area with one line per area", () => {
    const files = [
      file("client/src/app/Page.tsx", { additions: 3, deletions: 1 }),
      file("client/src/app/Panel.tsx", { additions: 1, deletions: 0 }),
      file("README.md", { additions: 2, deletions: 2 }),
      file("docs/guide.md", { additions: 5, deletions: 1 }),
    ];
    expect(groundedSummaryBullets(files, "zh")).toEqual([
      "- chore(app): 更新 2 个文件（+4 −1）",
      "- chore(docs): 更新 1 个文件（+5 −1）",
      "- chore(repo): 更新 1 个文件（+2 −2）",
    ]);
    expect(groundedSummaryBullets(files, "en")[0]).toBe(
      "- chore(app): update 2 files (+4 -1)",
    );
    // A summary never lists paths.
    for (const bullet of groundedSummaryBullets(files, "en"))
      expect(bullet).not.toContain("Page.tsx");
  });
  it("rolls the smallest areas into one line when they exceed the summary cap", () => {
    const files = Array.from({ length: 10 }, (_, index) =>
      file(`src/dir-${index}/file.ts`, { additions: 1, deletions: 0 }),
    );
    const bullets = groundedSummaryBullets(files, "zh");
    expect(bullets).toHaveLength(MAX_SUMMARY_BULLETS);
    expect(bullets[0]).toBe("- chore(dir-0): 更新 1 个文件（+1 −0）");
    expect(bullets.at(-1)).toBe("- chore(repo): 其余 3 个目录共 3 个文件（+3 −0）");
  });
  it("drops a reasoning block before the answer is read", () => {
    expect(
      stripReasoning("<think>weighing options</think>\nfeat(ui): 新增按钮"),
    ).toBe("feat(ui): 新增按钮");
    expect(stripReasoning("feat(ui): 新增按钮\n<think>unfinished")).toBe(
      "feat(ui): 新增按钮",
    );
  });
  it("parses only complete bullets from a chatty answer", () => {
    const text = [
      "Here is the changelog:",
      "```",
      "- feat(ui): 新增按钮 (src/a.tsx)",
      "```",
      "Done.",
      "- fix(api): 修复路由 (src/b.ts)",
      "- feat(ui): 新增按钮 (src/a.tsx)",
      "* docs: 补充说明",
    ].join("\n");
    expect(parseChangelogEntries(text)).toEqual([
      "- feat(ui): 新增按钮 (src/a.tsx)",
      "- fix(api): 修复路由 (src/b.ts)",
      "- docs: 补充说明",
    ]);
  });
  it("cuts an over-long bullet instead of dropping its theme", () => {
    const long = `- feat(a): ${"很长的说明".repeat(80)}`;
    const entries = parseChangelogEntries(long);
    expect(entries).toHaveLength(1);
    expect(entries[0].length).toBe(MAX_ENTRY_CHARS);
    expect(entries[0].startsWith("- feat(a): ")).toBe(true);
  });
  it("folds batch answers into one grouped body and never lists every path", () => {
    const first = planCommitMessageBatches([
      file("src/a.ts", { additions: 5 }),
      file("src/b.ts", { additions: 4 }),
    ])[0];
    const second = planCommitMessageBatches([
      file("src/c.ts", { additions: 3, deletions: 1 }),
      file("src/d.ts", { additions: 1, deletions: 0 }),
    ])[0];
    const merged = mergeBatchAnswers(
      [
        {
          batch: first,
          text: [
            "feat(core): 汇总两处改动",
            "",
            "- feat(core): 新增生成流程",
            "- fix(ui): 调整按钮样式 (src/b.ts)",
          ].join("\n"),
        },
        {
          batch: second,
          text: ["feat(core): 另一批", "", "- feat(core): 新增生成流程", "- docs(readme): 补充使用说明"].join(
            "\n",
          ),
        },
      ],
      { title: "feat(core): 汇总两处改动", locale: "zh", maxChars: 10_000 },
    );
    expect(merged.split("\n")[0]).toBe("feat(core): 汇总两处改动");
    // Both batches described the same theme; it is stated once.
    expect(merged.match(/新增生成流程/g)).toHaveLength(1);
    expect(merged).toContain("- fix(ui): 调整按钮样式 (src/b.ts)");
    expect(merged).toContain("- docs(readme): 补充使用说明");
    // Paths the model did not name are not appended one by one.
    expect(merged).not.toContain("src/a.ts");
    expect(merged).not.toContain("src/c.ts");
    expect(merged).not.toContain("src/d.ts");
  });
  it("summarizes a batch that answered nothing by area, not by file", () => {
    const batch = planCommitMessageBatches([
      file("src/c.ts", { additions: 3, deletions: 1 }),
      file("src/d.ts", { additions: 1, deletions: 0 }),
      file("src/other/e.ts", { additions: 2, deletions: 0 }),
    ])[0];
    const merged = mergeBatchAnswers([{ batch, text: "" }], {
      title: "feat: 大提交",
      locale: "zh",
      maxChars: 10_000,
    });
    expect(merged.split("\n")[0]).toBe("feat: 大提交");
    expect(merged).toContain("- chore(src): 更新 2 个文件（+4 −1）");
    expect(merged).toContain("- chore(other): 更新 1 个文件（+2 −0）");
    for (const path of ["src/c.ts", "src/d.ts", "src/other/e.ts"])
      expect(merged).not.toContain(path);
  });
  it("does not repeat the title as a bullet or replace it with a file line", () => {
    const title = "fix(consumer): 增强 Redis 持久化屏障的降级与错误处理";
    const changed = file(
      "src/main/java/com/hp/state/RedisDurabilityBarrier.java",
      { additions: 12, deletions: 3 },
    );
    const test = file(
      "src/test/java/com/hp/state/RedisDurabilityBarrierTest.java",
      { additions: 40, deletions: 0 },
    );
    const batch = planCommitMessageBatches([changed, test])[0];
    const merged = mergeBatchAnswers(
      [
        {
          batch,
          text: [
            title,
            "",
            `- fix(consumer): 增强 Redis 持久化屏障的降级与错误处理 (${changed.path})`,
            "- test(consumer): 补充持久化屏障降级场景的单元测试",
          ].join("\n"),
        },
      ],
      { title, locale: "zh", maxChars: 10_000 },
    );
    expect(merged.split("\n")[0]).toBe(title);
    // The restated sentence is dropped, and no per-file line is invented.
    expect(merged).not.toContain("- fix(consumer): 增强 Redis 持久化屏障的降级与错误处理 (");
    expect(merged).not.toContain(changed.path);
    // A bullet that says something new is kept verbatim.
    expect(merged).toContain("- test(consumer): 补充持久化屏障降级场景的单元测试");
  });
  it("treats only a restated title as a repeat", () => {
    const title = "feat(api): 新增分页参数";
    expect(repeatsTitle("- feat(api): 新增分页参数 (src/a.ts)", title)).toBe(true);
    // A near-identical restatement is still the same sentence.
    expect(
      repeatsTitle("- feat(api): 新增分页参数与默认值 (src/a.ts)", title),
    ).toBe(false);
    expect(
      repeatsTitle(
        "- feat(api): 新增分页参数与默认值说明 (src/a.ts)",
        "feat(api): 新增分页参数与默认值",
      ),
    ).toBe(true);
    // The path may be written with full-width parentheses.
    expect(repeatsTitle("- feat(api): 新增分页参数（src/a.ts）", title)).toBe(true);
    expect(repeatsTitle("- feat(api): 新增分页参数（默认 20） (src/a.ts)", title)).toBe(
      false,
    );
    expect(repeatsTitle("- fix(api): 修复分页边界 (src/a.ts)", title)).toBe(false);
  });
  it("keeps the body scannable when the answer has too many bullets", () => {
    const files = Array.from({ length: 20 }, (_, index) =>
      file(`src/very-long-directory-name/component-${index}.tsx`),
    );
    const batch = planCommitMessageBatches(files)[0];
    const answer = [
      "feat: 大提交",
      "",
      ...Array.from({ length: 12 }, (_, index) => `- feat(part): 第 ${index} 项改动说明`),
    ].join("\n");
    const merged = mergeBatchAnswers([{ batch, text: answer }], {
      title: "feat: 大提交",
      locale: "zh",
      maxChars: 10_000,
    });
    const body = merged.split("\n\n")[1].split("\n");
    expect(body.slice(0, MAX_SUMMARY_BULLETS)).toHaveLength(MAX_SUMMARY_BULLETS);
    expect(body.slice(0, MAX_SUMMARY_BULLETS).every((line) => line.startsWith("- "))).toBe(true);
    expect(merged).toContain("另有 4 条说明未列出");
  });
  it("states the remainder when the message would exceed its cap", () => {
    const files = Array.from({ length: 20 }, (_, index) =>
      file(`src/very-long-directory-name/component-${index}.tsx`),
    );
    const batch = planCommitMessageBatches(files)[0];
    const answer = [
      "feat: 大提交",
      "",
      ...Array.from({ length: 6 }, (_, index) => `- feat(part): 第 ${index} 项说明`),
    ].join("\n");
    const merged = mergeBatchAnswers([{ batch, text: answer }], {
      title: "feat: 大提交",
      locale: "zh",
      maxChars: 120,
    });
    expect(merged).toContain("另有");
    expect(merged.length).toBeLessThanOrEqual(120);
  });
});
