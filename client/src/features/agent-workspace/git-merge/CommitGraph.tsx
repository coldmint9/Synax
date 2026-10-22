import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ConversationGitCommit } from "../../../adapters/transport/conversationGit";
import { Button } from "../../../shared/ui/ui/Button";
import { useGraphMotion } from "./graphMotion";
import { layoutCommitGraph } from "./model";

const rowHeight = 35;
const laneWidth = 17;
const pointX = (lane: number) => 12 + lane * laneWidth;

export interface PendingMergeGraph {
  key: string;
  target: string;
  sources: string[];
  parents: string[];
  candidateOid?: string;
}
/** Real history stays solid. A clearly labelled prospective merge is dashed. */
export function CommitGraph({
  commits,
  pendingMerge,
  animate = true,
}: {
  commits: ConversationGitCommit[];
  pendingMerge?: PendingMergeGraph;
  animate?: boolean;
}) {
  const [all, setAll] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const pendingOid =
    pendingMerge?.candidateOid &&
    commits.some((commit) => commit.oid === pendingMerge.candidateOid)
      ? pendingMerge.candidateOid
      : pendingMerge
        ? `pending:${pendingMerge.key}`
        : undefined;
  const projectedCommits = useMemo(() => {
    if (!pendingMerge || commits.some((commit) => commit.oid === pendingOid))
      return commits;
    return [
      {
        oid: pendingOid!,
        parents: [...new Set(pendingMerge.parents)],
        subject: `合并 ${pendingMerge.sources.join(" + ")} → ${pendingMerge.target}`,
        refs: [],
        author: "",
        date: "",
      },
      ...commits,
    ];
  }, [commits, pendingOid, pendingMerge]);
  const rows = useMemo(
    () => layoutCommitGraph(projectedCommits),
    [projectedCommits],
  );
  const motion = useGraphMotion(Boolean(pendingMerge) && animate);
  const visible = all ? rows : rows.slice(0, 7);
  const positions = new Map(
    visible.map((row, index) => [row.commit.oid, { lane: row.lane, index }]),
  );
  const width = Math.max(
    45,
    24 + Math.max(0, ...visible.map((row) => row.lane)) * laneWidth,
  );
  const renderedWidth = Math.min(width, 88);
  const detail = commits.find((commit) => commit.oid === selected);
  return (
    <section
      ref={motion.ref}
      className="conversation-git-graph"
      data-motion={motion.running ? "running" : "paused"}
      aria-label="提交关系与待合并预览"
    >
      <div className="conversation-git-section-label">
        <span>分支与提交</span>
        <span>
          {commits.length ? "基于当前冻结的分支快照" : "暂无提交记录"}
        </span>
      </div>
      <div
        className="conversation-git-graph-layout"
        style={{ gridTemplateColumns: `${renderedWidth}px minmax(0, 1fr)` }}
      >
        <svg
          className="conversation-git-tree"
          width={renderedWidth}
          height={visible.length * rowHeight}
          viewBox={`0 0 ${width} ${visible.length * rowHeight}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {visible.flatMap((row) =>
            row.commit.parents.flatMap((parent) => {
              const from = positions.get(row.commit.oid)!;
              const to = positions.get(parent);
              if (!to) return [];
              const start = {
                x: pointX(from.lane),
                y: from.index * rowHeight + rowHeight / 2,
              };
              const end = {
                x: pointX(to.lane),
                y: to.index * rowHeight + rowHeight / 2,
              };
              return (
                <path
                  key={`${row.commit.oid}:${parent}`}
                  className={`conversation-git-edge lane-${from.lane % 3}${row.commit.oid === pendingOid ? " is-pending" : ""}`}
                  d={`M ${start.x} ${start.y} C ${start.x} ${(start.y + end.y) / 2}, ${end.x} ${(start.y + end.y) / 2}, ${end.x} ${end.y}`}
                />
              );
            }),
          )}
          {visible.map((row, index) => (
            <circle
              key={row.commit.oid}
              className={`conversation-git-node lane-${row.lane % 3}${row.commit.oid === pendingOid ? " is-pending" : ""}`}
              cx={pointX(row.lane)}
              cy={index * rowHeight + rowHeight / 2}
              r={index === 0 ? 4 : 3}
            />
          ))}
        </svg>
        <ol className="conversation-git-graph-rows">
          {visible.map(({ commit }) => (
            <li key={commit.oid}>
              <button
                className="conversation-git-commit"
                onClick={() =>
                  setSelected(
                    commit.oid.startsWith("pending:")
                      ? null
                      : selected === commit.oid
                        ? null
                        : commit.oid,
                  )
                }
                aria-expanded={selected === commit.oid}
                title={
                  commit.oid.startsWith("pending:")
                    ? "待产生的合并提交；虚线表示计划关系"
                    : `${commit.subject} · ${commit.oid}`
                }
              >
                <span className="conversation-git-commit-copy">
                  <strong>{commit.subject}</strong>
                  {commit.refs.length > 0 && (
                    <small>{commit.refs.join(" · ")}</small>
                  )}
                </span>
                {commit.oid === pendingOid ? (
                  <span className="conversation-git-pending-label">待合并</span>
                ) : (
                  <code>{commit.oid.slice(0, 7)}</code>
                )}
                {selected === commit.oid ? (
                  <ChevronDown size={12} />
                ) : (
                  <ChevronRight size={12} />
                )}
              </button>
            </li>
          ))}
        </ol>
      </div>
      {detail && (
        <div className="conversation-git-commit-detail">
          <strong>{detail.subject}</strong>
          <span>
            {detail.author} · {detail.date}
          </span>
          <code>{detail.oid}</code>
          <span>
            {detail.parents.length
              ? `父提交：${detail.parents.map((parent) => parent.slice(0, 8)).join(", ")}`
              : "根提交"}
          </span>
        </div>
      )}
      {rows.length > 7 && (
        <Button
          className="conversation-git-expand-history"
          size="xs"
          variant="ghost"
          onClick={() => setAll(!all)}
        >
          {all ? "收起提交历史" : `查看其余 ${rows.length - 7} 个提交`}
          <ChevronDown size={12} />
        </Button>
      )}
    </section>
  );
}
