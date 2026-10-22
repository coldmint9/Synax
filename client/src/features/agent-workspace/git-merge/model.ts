import type {
  ConversationGitSnapshot,
  ConversationGitCommit,
} from "../../../adapters/transport/conversationGit";
import {
  canFinalize,
  isRunning,
  isTerminal,
  statusLabels,
} from "../../git/mergeUi";
export { canFinalize, isRunning, isTerminal };

export function taskPresentation(snapshot: ConversationGitSnapshot) {
  const { mr, files, stale } = snapshot;
  const conflicts = files.filter((file) => file.conflicted).length;
  const results = mr.checks.map((check) => {
    const result = [...mr.checkResults]
      .reverse()
      .find((item) => item.id === check.id);
    return {
      check,
      result,
      current: !!result && result.tree === mr.candidateTree,
    };
  });
  const passed = results.filter(
    (item) => item.current && item.result?.status === "passed",
  ).length;
  const complete = mr.status === "merged" || mr.status === "noop";
  const terminal = isTerminal(mr.status);
  const step = complete
    ? 4
    : stale || mr.status === "conflicted"
      ? 1
      : ["draft", "preparing"].includes(mr.status)
        ? 0
        : mr.status === "applying" || canFinalize(mr)
          ? 3
          : 2;
  const status =
    stale && !terminal
      ? "分支已更新"
      : mr.status === "ready"
        ? mr.checks.length
          ? passed === mr.checks.length
            ? "可以合并"
            : "等待验证"
          : "等待人工确认"
        : statusLabels[mr.status];
  return {
    conflicts,
    results,
    passed,
    complete,
    terminal,
    step,
    status,
    canFinalize: !stale && canFinalize(mr),
    running: isRunning(mr.status),
  };
}

export interface GraphRow {
  commit: ConversationGitCommit;
  lane: number;
}
/** Keep parent relationships from Git; never invent a commit or an edge. */
export function layoutCommitGraph(
  commits: ConversationGitCommit[],
): GraphRow[] {
  const lanes: Array<string | null> = [];
  return commits.map((commit) => {
    let lane = lanes.indexOf(commit.oid);
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.length;
    }
    lanes[lane] = null;
    for (const [index, parent] of commit.parents.entries()) {
      if (lanes.includes(parent)) continue;
      if (index === 0) lanes[lane] = parent;
      else {
        const empty = lanes.indexOf(null);
        lanes[empty >= 0 ? empty : lanes.length] = parent;
      }
    }
    return { commit, lane };
  });
}
