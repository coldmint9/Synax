import { useState } from "react";
import {
  Check,
  CircleAlert,
  CircleSlash,
  GitCommitVertical,
  LoaderCircle,
  MessageSquare,
  Tag,
} from "lucide-react";
import type {
  RemotePrCheck,
  RemotePrCommit,
  RemotePrPipelineStage,
  RemotePrStats,
  RemotePullRequest,
} from "../../../adapters/transport/remotePr";
import { mergeRequestRef, type MergeRequestTerms } from "./mrTerms";
import "./mergeRequest.css";

const statusText: Record<RemotePrCheck["status"], string> = {
  passed: "通过",
  failed: "失败",
  pending: "运行中",
  unknown: "未知",
};

function StatusIcon({ status }: { status: RemotePrCheck["status"] }) {
  if (status === "passed") return <Check size={12} aria-hidden />;
  if (status === "pending")
    return <LoaderCircle size={12} className="mr-spin" aria-hidden />;
  if (status === "failed") return <CircleAlert size={12} aria-hidden />;
  return <CircleSlash size={12} aria-hidden />;
}

function date(value: string) {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toISOString().slice(0, 10);
}

/** GitLab pipeline stages form one visual track: the merge gate at a glance. */
function PipelineTrack({ stages }: { stages: RemotePrPipelineStage[] }) {
  const [open, setOpen] = useState<string | null>(() => {
    const failed = stages.find((stage) => stage.status === "failed");
    return failed?.name ?? null;
  });
  const active = stages.find((stage) => stage.name === open) ?? null;
  return (
    <section className="mr-section" aria-label="流水线">
      <ol className="mr-stages">
        {stages.map((stage) => {
          const selected = stage.name === open;
          return (
            <li
              key={stage.name}
              className={`mr-stage mr-stage--${stage.status}`}
              data-status={stage.status}
            >
              <button
                type="button"
                aria-pressed={selected}
                aria-label={`${stage.name}：${statusText[stage.status]}`}
                title={`${stage.name} · ${statusText[stage.status]}${stage.jobs.length ? ` · ${stage.jobs.length} 个作业` : ""}`}
                onClick={() =>
                  setOpen(selected && stage.jobs.length === 0 ? null : stage.name)
                }
                disabled={!stage.jobs.length}
              >
                <span className="mr-stage__bar" aria-hidden />
                <span className="mr-stage__name">{stage.name}</span>
                <span className="mr-stage__status">
                  <StatusIcon status={stage.status} />
                  {stage.jobs.length > 0 && <small>{stage.jobs.length}</small>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {active && active.jobs.length > 0 && (
        <ul className="mr-jobs" aria-label={`${active.name} 作业`}>
          {active.jobs.map((job, index) => (
            <li key={`${job.name}:${index}`} className={`mr-job mr-job--${job.status}`}>
              <StatusIcon status={job.status} />
              {job.url ? (
                <a href={job.url} target="_blank" rel="noreferrer">
                  {job.name}
                </a>
              ) : (
                <span>{job.name}</span>
              )}
              <small>{statusText[job.status]}</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Without pipeline stages the platform still reports individual checks. */
function CheckList({ checks }: { checks: RemotePrCheck[] }) {
  return (
    <section className="mr-section" aria-label="检查">
      <ul className="mr-jobs">
        {checks.map((check, index) => (
          <li key={`${check.name}:${index}`} className={`mr-job mr-job--${check.status}`}>
            <StatusIcon status={check.status} />
            {check.url ? (
              <a href={check.url} target="_blank" rel="noreferrer">
                {check.name}
              </a>
            ) : (
              <span>{check.name}</span>
            )}
            <small>{statusText[check.status]}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Approvals({ pr }: { pr: RemotePullRequest }) {
  const review = pr.review;
  if (!review) return null;
  const approved = review.approvedBy.length;
  const waiting = review.reviewers.filter(
    (name) => !review.approvedBy.includes(name),
  );
  if (!review.required && !approved && !review.reviewers.length) return null;
  const done = review.required > 0 && approved >= review.required;
  return (
    <section className="mr-section" aria-label="审核">
      <div className="mr-review">
        <span className={`mr-review__count ${done ? "is-done" : ""}`}>
          <Check size={12} aria-hidden />
          {review.required > 0 ? `${approved}/${review.required}` : approved}
        </span>
        {(review.approvedBy.length ? review.approvedBy : waiting).map((name) => (
          <span
            key={name}
            className={`mr-chip ${review.approvedBy.includes(name) ? "is-approved" : ""}`}
            title={review.approvedBy.includes(name) ? "已批准" : "待评审"}
          >
            @{name}
          </span>
        ))}
      </div>
    </section>
  );
}

function Changes({ stats }: { stats: RemotePrStats }) {
  const total = stats.additions + stats.deletions;
  const added = total > 0 ? (stats.additions / total) * 100 : 0;
  return (
    <section className="mr-section mr-changes" aria-label="改动">
      <span className="mr-changes__added">+{stats.additions}</span>
      <span className="mr-changes__removed">−{stats.deletions}</span>
      <span
        className="mr-changes__bar"
        aria-hidden
        title={`新增 ${stats.additions} 行，删除 ${stats.deletions} 行`}
      >
        <span style={{ width: `${added}%` }} />
      </span>
      <small>{stats.files} 个文件</small>
    </section>
  );
}

function Commits({ commits }: { commits: RemotePrCommit[] }) {
  return (
    <details className="mr-section mr-commits">
      <summary>
        <GitCommitVertical size={12} aria-hidden />
        {commits.length} 个提交
      </summary>
      <ol>
        {commits.map((commit) => (
          <li key={commit.sha}>
            <code title={commit.sha}>{commit.sha.slice(0, 7)}</code>
            <span>{commit.title}</span>
            <small>
              {commit.author}
              {date(commit.createdAt) ? ` · ${date(commit.createdAt)}` : ""}
            </small>
          </li>
        ))}
      </ol>
    </details>
  );
}

export default function MergeRequestOverview({
  pr,
  terms,
}: {
  pr: RemotePullRequest;
  terms: MergeRequestTerms;
}) {
  const stages = pr.pipeline?.stages ?? [];
  const hasPipeline = stages.length > 0;
  return (
    <div className="mr-overview">
      <div className="mr-overview__line">
        <span className="mr-overview__ref">
          {mergeRequestRef(terms, pr.number)}
        </span>
        <span className="mr-branches">
          <code>{pr.head}</code>
          <span aria-hidden>→</span>
          <code>{pr.base}</code>
        </span>
        {typeof pr.notesCount === "number" && pr.notesCount > 0 && (
          <span className="mr-meta" title="讨论数量">
            <MessageSquare size={12} aria-hidden />
            {pr.notesCount}
          </span>
        )}
        {pr.url && (
          <a className="mr-open" href={pr.url} target="_blank" rel="noreferrer">
            在 {terms.platform} 打开
          </a>
        )}
      </div>
      {(pr.labels?.length ?? 0) > 0 && (
        <div className="mr-labels">
          <Tag size={11} aria-hidden />
          {pr.labels!.map((label) => (
            <span key={label} className="mr-chip">
              {label}
            </span>
          ))}
        </div>
      )}
      {hasPipeline ? (
        <PipelineTrack stages={stages} />
      ) : pr.checks.length ? (
        <CheckList checks={pr.checks} />
      ) : null}
      <div className="mr-overview__facts">
        <Approvals pr={pr} />
        {pr.stats && <Changes stats={pr.stats} />}
      </div>
      {pr.checksError && <p className="mr-hint">{pr.checksError}</p>}
      {pr.detailError && <p className="mr-hint">{pr.detailError}</p>}
      {pr.commits && pr.commits.length > 0 && <Commits commits={pr.commits} />}
      {pr.body && (
        <details className="mr-section mr-description">
          <summary>描述</summary>
          <p>{pr.body}</p>
        </details>
      )}
    </div>
  );
}
