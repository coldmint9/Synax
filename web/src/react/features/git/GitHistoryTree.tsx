import { useMemo, useState } from "react";
import { Table } from "@heroui/react";
import { GitBranch, GitCommitHorizontal, GitMerge, Search } from "lucide-react";
import type { GitCommitSummary, GitWorkspaceSummary } from "../../../lib/api/project";

type HistoryFilter = "all" | "merge" | "workspace";
const LANE_WIDTH = 22;
const ROW_HEIGHT = 68;
const RAIL_WIDTH = 94;

type TopologyConnection = { from: number; to: number; merge: boolean };
type TopologyRow = { nodeLane: number; connections: TopologyConnection[] };

export function buildTopology(
  commits: GitCommitSummary[],
) {
  let active: string[] = [];
  const rows: TopologyRow[] = [];

  commits.forEach((commit) => {
    const before = [...active];
    const existingLane = before.indexOf(commit.id);
    const nodeLane = existingLane >= 0 ? existingLane : before.length;
    const parents = commit.parents.filter((parent) => commits.some((item) => item.id === parent));
    const after = before.slice();
    after.splice(nodeLane, 1, ...parents);
    const uniqueAfter = [...new Set(after)];
    const connections: TopologyConnection[] = [];

    before.forEach((laneId, from) => {
      if (laneId === commit.id) return;
      const to = uniqueAfter.indexOf(laneId);
      if (to >= 0) connections.push({ from, to, merge: false });
    });
    parents.forEach((parent) => {
      const to = uniqueAfter.indexOf(parent);
      if (to >= 0) connections.push({ from: nodeLane, to, merge: parents.length > 1 });
    });

    active = uniqueAfter;
    rows.push({ nodeLane, connections });
  });
  return rows;
}

function laneX(lane: number) {
  return 16 + lane * LANE_WIDTH;
}

function topologyPath(from: number, to: number, row: number) {
  const fromX = laneX(from);
  const toX = laneX(to);
  const fromY = row * ROW_HEIGHT + ROW_HEIGHT / 2;
  const toY = (row + 1) * ROW_HEIGHT + ROW_HEIGHT / 2;
  if (fromX === toX) return `M ${fromX} ${fromY} L ${toX} ${toY}`;
  return `M ${fromX} ${fromY} C ${fromX} ${fromY + 15}, ${toX} ${toY - 15}, ${toX} ${toY}`;
}

function shortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

export default function GitHistoryTree({ workspace }: { workspace: GitWorkspaceSummary }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const commits = workspace.commits ?? [];
  const currentHeads = useMemo(() => new Set(workspace.worktrees.filter((item) => item.primary).map((item) => item.head)), [workspace.worktrees]);
  const dirtyHeads = useMemo(() => new Set(workspace.worktrees.filter((item) => item.dirty).map((item) => item.head)), [workspace.worktrees]);
  const filteredCommits = commits.filter((commit) => {
    const textMatch = `${commit.subject} ${commit.author} ${commit.id} ${commit.refs.join(" ")}`.toLowerCase().includes(query.toLowerCase());
    const filterMatch = filter === "all" || (filter === "merge" && commit.parents.length > 1) || (filter === "workspace" && (currentHeads.has(commit.id) || dirtyHeads.has(commit.id)));
    return textMatch && filterMatch;
  });
  const topology = useMemo(() => buildTopology(filteredCommits), [filteredCommits]);
  const selected = commits.find((commit) => commit.id === selectedId);
  const graphHeight = Math.max(1, filteredCommits.length) * ROW_HEIGHT;

  if (!commits.length) return <div className="history-tree-empty">当前仓库没有可展示的提交记录。</div>;
  return (
    <div className="history-tree">
      <header className="history-tree-toolbar">
        <label className="history-tree-search">
          <Search size={15} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索提交、分支或作者" aria-label="搜索提交、分支或作者" />
        </label>
        <div className="history-tree-filters" role="group" aria-label="提交筛选">
          {([["all", "全部"], ["merge", "合并提交"], ["workspace", "工作区"]] as const).map(([id, label]) => (
            <button key={id} type="button" className={filter === id ? "is-active" : ""} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        <span className="history-tree-count">{filteredCommits.length} / {commits.length} 条活动</span>
      </header>
      <div className="history-tree-table-wrap">
        <svg className="history-tree-rail" viewBox={`0 0 ${RAIL_WIDTH} ${graphHeight}`} aria-hidden="true" preserveAspectRatio="none">
          {topology.flatMap((row, index) => row.connections.map((connection, connectionIndex) => (
            <path key={`${index}-${connectionIndex}`} d={topologyPath(connection.from, connection.to, index)} className={connection.merge ? "is-merge" : connection.from === 0 ? "is-main" : "is-branch"} />
          )))}
          {filteredCommits.map((commit, index) => {
            const lane = topology[index]?.nodeLane ?? 0;
            const merge = commit.parents.length > 1;
            return <circle key={commit.id} cx={laneX(lane)} cy={index * ROW_HEIGHT + ROW_HEIGHT / 2} r={merge ? 7 : 5} className={merge ? "is-merge" : currentHeads.has(commit.id) ? "is-current" : ""} />;
          })}
        </svg>
        <Table variant="secondary" className="history-tree-table">
          <Table.ScrollContainer className="history-tree-scroll">
            <Table.Content aria-label="Git 提交历史" className="history-tree-content">
              <Table.Header>
                <Table.Column isRowHeader>提交标题</Table.Column>
                <Table.Column>分支标签</Table.Column>
                <Table.Column>作者</Table.Column>
                <Table.Column>时间</Table.Column>
                <Table.Column aria-label="状态" />
              </Table.Header>
              <Table.Body>
                {filteredCommits.map((commit, index) => {
                  const isCurrent = currentHeads.has(commit.id);
                  const isDirty = dirtyHeads.has(commit.id);
                  const isMerge = commit.parents.length > 1;
                  const isRebase = commit.rebase;
                  return (
                    <Table.Row key={commit.id} className={selectedId === commit.id ? "history-table-row-selected" : undefined}>
                      <Table.Cell>
                        <button type="button" className="history-table-title-button" title={commit.subject || "无提交说明"} onClick={() => setSelectedId(commit.id)}>
                          <strong>{commit.subject || "无提交说明"}</strong>
                        </button>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="history-tree-ref-list">
                          {commit.refs.map((ref) => <span className="history-tree-ref" key={ref}><GitBranch size={12} />{ref}</span>)}
                          {isMerge && <span className="history-tree-ref is-merge"><GitMerge size={12} />合并</span>}
                          {isRebase && <span className="history-tree-ref is-rebase">↻ rebase</span>}
                        </div>
                      </Table.Cell>
                      <Table.Cell><span className="history-tree-author">{commit.author}</span></Table.Cell>
                      <Table.Cell><time dateTime={commit.authoredAt}>{shortDate(commit.authoredAt)}</time></Table.Cell>
                      <Table.Cell>
                        <span className={`history-tree-status ${isDirty ? "is-dirty" : isCurrent ? "is-current" : isMerge ? "is-merge" : isRebase ? "is-rebase" : ""}`} aria-label={isDirty ? "有未提交更改" : isCurrent ? "当前工作区 HEAD" : isMerge ? "合并提交" : isRebase ? "rebase 重写" : "普通提交"}>
                          {isDirty ? "!" : isCurrent ? "HEAD" : isMerge ? "↗" : isRebase ? "R" : "·"}
                        </span>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      </div>
      {selected && <aside className="history-tree-detail"><div className="history-tree-detail-mark"><GitCommitHorizontal size={16} /></div><div><strong>{selected.subject}</strong><p>{selected.id.slice(0, 12)} · {selected.author} · {shortDate(selected.authoredAt)}</p></div></aside>}
    </div>
  );
}
