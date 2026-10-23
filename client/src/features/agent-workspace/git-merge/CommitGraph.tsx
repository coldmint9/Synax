import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ConversationGitCommit } from "../../../adapters/transport/conversationGit";
import { useGraphMotion } from "./graphMotion";
import { layoutCommitGraph } from "./model";
import { VirtualList } from "./VirtualList";

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
/** The topology covers all commits; only the visible nodes and intersecting edges mount. */
export function CommitGraph({
  commits,
  pendingMerge,
  animate = true,
}: {
  commits: ConversationGitCommit[];
  pendingMerge?: PendingMergeGraph;
  animate?: boolean;
}) {
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
  const graph = useMemo(() => {
    const rows = layoutCommitGraph(projectedCommits);
    const positions = new Map(
      rows.map((row, index) => [row.commit.oid, { lane: row.lane, index }]),
    );
    const edges = rows.flatMap((row) =>
      row.commit.parents.flatMap((parent) => {
        const from = positions.get(row.commit.oid)!,
          to = positions.get(parent);
        if (!to) return [];
        const start = {
          x: pointX(from.lane),
          y: from.index * rowHeight + rowHeight / 2,
        };
        const end = {
          x: pointX(to.lane),
          y: to.index * rowHeight + rowHeight / 2,
        };
        return [
          {
            key: `${row.commit.oid}:${parent}`,
            oid: row.commit.oid,
            lane: from.lane,
            from: from.index,
            to: to.index,
            d: `M ${start.x} ${start.y} C ${start.x} ${(start.y + end.y) / 2}, ${end.x} ${(start.y + end.y) / 2}, ${end.x} ${end.y}`,
          },
        ];
      }),
    );
    const width = rows.reduce(
      (width, row) => Math.max(width, 24 + row.lane * laneWidth),
      45,
    );
    return { rows, edges, width, renderedWidth: Math.min(width, 88) };
  }, [projectedCommits]);
  const motion = useGraphMotion(Boolean(pendingMerge) && animate);
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
          {commits.length
            ? `${commits.length} 个提交${graph.rows.length > 7 ? " · 滚动查看" : ""}`
            : "暂无提交记录"}
        </span>
      </div>
      <VirtualList
        items={graph.rows}
        getKey={(row) => row.commit.oid}
        rowHeight={rowHeight}
        maxHeight={245}
        label="提交列表"
        className="conversation-git-graph-window"
        contentStyle={{ paddingLeft: graph.renderedWidth }}
        decoration={(range) => (
          <svg
            className="conversation-git-tree conversation-git-tree--window"
            width={graph.renderedWidth}
            height={(range.end - range.start) * rowHeight}
            style={{ top: range.offset }}
            viewBox={`0 ${range.offset} ${graph.width} ${(range.end - range.start) * rowHeight}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {graph.edges
              .filter(
                (edge) =>
                  Math.min(edge.from, edge.to) < range.end &&
                  Math.max(edge.from, edge.to) >= range.start,
              )
              .map((edge) => (
                <path
                  key={edge.key}
                  className={`conversation-git-edge lane-${edge.lane % 3}${edge.oid === pendingOid ? " is-pending" : ""}`}
                  d={edge.d}
                />
              ))}
            {graph.rows.slice(range.start, range.end).map((row, offset) => (
              <circle
                key={row.commit.oid}
                className={`conversation-git-node lane-${row.lane % 3}${row.commit.oid === pendingOid ? " is-pending" : ""}`}
                cx={pointX(row.lane)}
                cy={(range.start + offset) * rowHeight + rowHeight / 2}
                r={range.start + offset === 0 ? 4 : 3}
              />
            ))}
          </svg>
        )}
        renderRow={({ commit }) => (
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
        )}
      />
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
    </section>
  );
}
