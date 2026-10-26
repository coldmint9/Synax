import { expect, it } from "vitest";
import { chooseMergeSnapshot } from "./mergeTaskProjection";
import type { ConversationGitSnapshot } from "../../../adapters/transport/conversationGit";

it("accepts a newer task binding even when the replanned MR version restarts", () => {
  const old = {
    task: { revision: 10, mrId: "old" },
    mr: { version: 40 },
  } as ConversationGitSnapshot;
  const replanned = {
    task: { revision: 11, mrId: "new" },
    mr: { version: 1 },
  } as ConversationGitSnapshot;
  expect(chooseMergeSnapshot(old, replanned)).toBe(replanned);
  expect(chooseMergeSnapshot(replanned, old)).toBe(replanned);
});
