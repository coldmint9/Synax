import {
  ArrowDown,
  ArrowUpRight,
  Check,
  ChevronRight,
  ListTodo,
  MessageCircle,
  Loader2,
  PenLine,
  X,
} from "lucide-react";
import "./agentControls.css";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  type AgentInteraction,
  type AgentInteractionReply,
  type AgentPlan,
  type AgentSession,
  type HumanQuestion,
} from "../../../lib/api/agentRuntime";
import { subscribe } from "../../../lib/api/runtimeEventBus";
import { useLocale } from "../../../hooks/useLocale";
import {
  scheduleSessionRefresh,
  useAgentSessionStore,
} from "./state/agentSessionStore";
import { MarkdownRenderer } from "../../components/markdown/MarkdownRenderer";
import { readSessionBackendId } from "./synaxSessionTypes";

const inputClass = "agent-request-input";
const buttonClass = "agent-request-action";

function AskMarkdown({ content }: { content: string }) {
  return (
    <MarkdownRenderer
      content={content}
      className="agent-request-markdown"
      conversationClass={false}
    />
  );
}

type Answers = NonNullable<AgentInteractionReply["answers"]>;

function PlanDetails({
  plan,
  zh,
  showTitle = true,
}: {
  plan: AgentPlan;
  zh: boolean;
  showTitle?: boolean;
}) {
  const sections: [string, string[]][] = [
    [zh ? "验收标准" : "Acceptance criteria", plan.acceptanceCriteria],
    [zh ? "假设" : "Assumptions", plan.assumptions],
    [zh ? "风险" : "Risks", plan.risks],
  ];
  return (
    <div className="agent-plan-details">
      {showTitle && <h4>{plan.title}</h4>}
      <p className="agent-plan-objective">{plan.objective}</p>
      <ol className="agent-plan-steps">
        {plan.steps.map((step, index) => (
          <li key={step.id}>
            <span className="agent-plan-step-number">
              {String(index + 1).padStart(2, "0")}
            </span>
            <details className="agent-plan-step">
              <summary>
                {step.title}
                <ChevronRight size={13} aria-hidden />
              </summary>
              <div>
                <p>{step.description}</p>
                {step.dependsOn.length > 0 && (
                  <p className="agent-plan-meta">
                    {zh ? "依赖：" : "Depends on: "}
                    {step.dependsOn.join(", ")}
                  </p>
                )}
                {step.expectedFiles.length > 0 && (
                  <ul className="agent-plan-files">
                    {step.expectedFiles.map((file) => (
                      <li key={file}>{file}</li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          </li>
        ))}
      </ol>
      <div className="agent-plan-supplement">
        {sections.map(
          ([title, entries]) =>
            entries.length > 0 && (
              <details key={title}>
                <summary>
                  {title}
                  <span>{entries.length}</span>
                  <ChevronRight size={12} aria-hidden />
                </summary>
                <ul>
                  {entries.map((item, index) => (
                    <li key={index}>
                      {item}
                      {entries === plan.acceptanceCriteria &&
                        plan.humanAcceptanceCriteria?.includes(item) && (
                          <span className="text-warning">
                            {zh ? "（需用户确认）" : " (user confirmation)"}
                          </span>
                        )}
                    </li>
                  ))}
                </ul>
              </details>
            ),
        )}
      </div>
    </div>
  );
}

function InteractionForm({
  interaction,
  disabled,
}: {
  interaction: AgentInteraction;
  disabled: boolean;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const formId = useId();
  const [values, setValues] = useState<Answers>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const questionRef = useRef<HTMLFieldSetElement>(null);
  const previousQuestionIndex = useRef(questionIndex);
  const [otherEnabled, setOtherEnabled] = useState<Record<string, boolean>>({});
  const [otherValues, setOtherValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const replyInteraction = useAgentSessionStore((s) => s.replyInteraction);
  const refreshInteractions = useAgentSessionStore(
    (s) => s.refreshInteractions,
  );
  const isPlan = interaction.kind === "plan_approval";
  const questions = interaction.request.questions ?? [];
  const paginated = !isPlan && questions.length > 1;
  const visibleQuestions = paginated
    ? questions.slice(questionIndex, questionIndex + 1)
    : questions;
  const hasNextQuestion = paginated && questionIndex < questions.length - 1;

  useEffect(() => {
    if (previousQuestionIndex.current !== questionIndex) {
      questionRef.current?.focus();
      previousQuestionIndex.current = questionIndex;
    }
  }, [questionIndex]);
  const update = (id: string, value: Answers[string]) =>
    setValues((current) => ({ ...current, [id]: value }));

  function collectAnswers(questionsToValidate = questions): Answers | null {
    const answers: Answers = {};
    const invalid: Record<string, string> = {};
    for (const question of questionsToValidate) {
      let value = values[question.id];
      if (typeof value === "string") value = value.trim();
      if (question.allowOther && otherEnabled[question.id]) {
        const other = otherValues[question.id]?.trim();
        if (!other) {
          invalid[question.id] = zh
            ? "请填写其他选项"
            : "Enter an other option";
          continue;
        }
        value =
          question.type === "multi_select"
            ? [...new Set([...(Array.isArray(value) ? value : []), other])]
            : other;
      }
      const empty =
        value === undefined ||
        value === "" ||
        (Array.isArray(value) && value.length === 0);
      if (empty) {
        if (question.required) invalid[question.id] = zh ? "必填" : "Required";
        continue;
      }
      if (question.type === "number") {
        value = Number(value);
        if (!Number.isFinite(value)) {
          invalid[question.id] = zh
            ? "请输入有效数字"
            : "Enter a finite number";
          continue;
        }
      }
      const size =
        question.type === "number" && typeof value === "number"
          ? value
          : (question.type === "text" || question.type === "textarea") &&
              typeof value === "string"
            ? value.length
            : question.type === "multi_select" && Array.isArray(value)
              ? value.length
              : undefined;
      if (
        size !== undefined &&
        ((question.min !== undefined && size < question.min) ||
          (question.max !== undefined && size > question.max))
      ) {
        invalid[question.id] = zh
          ? `超出范围（最小 ${question.min ?? "—"}，最大 ${question.max ?? "—"}）`
          : `Out of bounds (min ${question.min ?? "—"}, max ${question.max ?? "—"})`;
      } else {
        answers[question.id] = value;
      }
    }
    setErrors(invalid);
    if (Object.keys(invalid).length) {
      if (paginated) {
        setQuestionIndex(
          questions.findIndex((question) => invalid[question.id]),
        );
      }
      return null;
    }
    return answers;
  }

  async function reply(action: AgentInteractionReply["action"]) {
    if (disabled || submittingRef.current) return;
    const answers = action === "submit" ? collectAnswers() : undefined;
    if (answers === null) return;
    submittingRef.current = true;
    setSubmitting(true);
    setServerError(null);
    try {
      await replyInteraction(interaction.sessionId, interaction.id, {
        revision: interaction.revision,
        action,
        ...(answers ? { answers } : {}),
      });
    } catch (error) {
      setServerError(error instanceof Error ? error.message : String(error));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function questionInput(question: HumanQuestion) {
    const value = values[question.id];
    const id = `${formId}-${question.id}`;
    const common = {
      id,
      "aria-label": question.label,
      "aria-required": Boolean(question.required),
      "aria-invalid": Boolean(errors[question.id]),
      "aria-describedby": errors[question.id] ? `${id}-error` : undefined,
      className: inputClass,
    };
    if (question.type === "single_select" || question.type === "multi_select") {
      const multiple = question.type === "multi_select";
      const selected = Array.isArray(value) ? value : [];
      return (
        <div className="agent-request-choices">
          {(question.options ?? []).map((option, index) => {
            const checked = multiple
              ? selected.includes(option.value)
              : !otherEnabled[question.id] && value === option.value;
            return (
              <label
                key={option.value}
                className="agent-request-choice"
                data-selected={checked || undefined}
              >
                <input
                  className="sr-only"
                  type={multiple ? "checkbox" : "radio"}
                  name={id}
                  checked={checked}
                  aria-label={`${option.label}${question.recommended?.includes(option.value) ? ` (${zh ? "推荐" : "Recommended"})` : ""}`}
                  aria-describedby={common["aria-describedby"]}
                  onChange={(event) => {
                    if (multiple)
                      update(
                        question.id,
                        event.target.checked
                          ? [...selected, option.value]
                          : selected.filter((item) => item !== option.value),
                      );
                    else {
                      update(question.id, option.value);
                      setOtherEnabled((current) => ({
                        ...current,
                        [question.id]: false,
                      }));
                    }
                  }}
                />
                <span className="agent-request-choice-index" aria-hidden="true">
                  {checked ? <Check size={15} /> : index + 1}
                </span>
                <div className="agent-request-choice-copy">
                  <AskMarkdown content={option.label} />
                </div>
                {question.recommended?.includes(option.value) && (
                  <span className="agent-request-choice-recommended">
                    {zh ? "推荐" : "Recommended"}
                  </span>
                )}
                <ChevronRight
                  size={18}
                  aria-hidden="true"
                  className="agent-request-choice-arrow"
                />
              </label>
            );
          })}
          {question.allowOther && (
            <>
              <label
                className="agent-request-choice agent-request-choice--other"
                data-selected={otherEnabled[question.id] || undefined}
              >
                <input
                  className="sr-only"
                  type={multiple ? "checkbox" : "radio"}
                  name={id}
                  checked={Boolean(otherEnabled[question.id])}
                  aria-label={zh ? "其他" : "Other"}
                  onChange={(event) =>
                    setOtherEnabled((current) => ({
                      ...current,
                      [question.id]: event.target.checked,
                    }))
                  }
                />
                <span className="agent-request-choice-index" aria-hidden="true">
                  <PenLine size={14} />
                </span>
                <span className="agent-request-choice-copy">
                  {zh ? "其他" : "Other"}
                </span>
                <ChevronRight
                  size={18}
                  aria-hidden="true"
                  className="agent-request-choice-arrow"
                />
              </label>
              {otherEnabled[question.id] && (
                <input
                  {...common}
                  aria-label={`${question.label} — ${zh ? "其他" : "Other"}`}
                  value={otherValues[question.id] ?? ""}
                  onChange={(event) =>
                    setOtherValues((current) => ({
                      ...current,
                      [question.id]: event.target.value,
                    }))
                  }
                />
              )}
            </>
          )}
        </div>
      );
    }
    if (question.type === "boolean") {
      return (
        <div className="agent-request-choices agent-request-choices--compact">
          {[
            ["true", zh ? "是" : "Yes"],
            ["false", zh ? "否" : "No"],
          ].map(([choice, label], index) => {
            const checked =
              typeof value === "boolean" && String(value) === choice;
            return (
              <label
                key={choice}
                className="agent-request-choice"
                data-selected={checked || undefined}
              >
                <input
                  className="sr-only"
                  type="radio"
                  name={id}
                  value={choice}
                  checked={checked}
                  aria-label={label}
                  onChange={() => update(question.id, choice === "true")}
                />
                <span className="agent-request-choice-index" aria-hidden="true">
                  {checked ? <Check size={15} /> : index + 1}
                </span>
                <span className="agent-request-choice-copy">{label}</span>
                <ChevronRight
                  size={18}
                  aria-hidden="true"
                  className="agent-request-choice-arrow"
                />
              </label>
            );
          })}
        </div>
      );
    }
    if (question.type === "textarea") {
      return (
        <textarea
          {...common}
          rows={3}
          minLength={question.min}
          maxLength={question.max}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => update(question.id, event.target.value)}
        />
      );
    }
    return (
      <input
        {...common}
        type={question.type}
        step={question.type === "number" ? "any" : undefined}
        min={question.type === "number" ? question.min : undefined}
        max={question.type === "number" ? question.max : undefined}
        minLength={question.type === "text" ? question.min : undefined}
        maxLength={question.type === "text" ? question.max : undefined}
        value={
          typeof value === "string" || typeof value === "number" ? value : ""
        }
        onChange={(event) => update(question.id, event.target.value)}
      />
    );
  }

  return (
    <form
      noValidate
      aria-labelledby={`${formId}-title`}
      aria-busy={submitting}
      onSubmit={(event) => {
        event.preventDefault();
        if (isPlan || disabled || submittingRef.current) return;
        if (hasNextQuestion) {
          if (collectAnswers(visibleQuestions) !== null) {
            setQuestionIndex((index) => index + 1);
          }
        } else {
          void reply("submit");
        }
      }}
      className="agent-request-surface"
    >
      <header className="agent-request-header">
        <span className="agent-interaction-icon" aria-hidden>
          {isPlan ? <ListTodo size={18} /> : <MessageCircle size={18} />}
        </span>
        <div className="agent-request-heading">
          <span className="agent-interaction-eyebrow">
            {isPlan
              ? zh
                ? "计划 · 待确认"
                : "PLAN · READY FOR REVIEW"
              : zh
                ? "需要你的意见"
                : "YOUR INPUT"}
            <span>v{interaction.revision}</span>
          </span>
          <h3 id={`${formId}-title`} className="agent-request-title">
            {interaction.request.title}
          </h3>
        </div>
        {submitting && (
          <Loader2
            size={18}
            className="shrink-0 animate-spin motion-reduce:animate-none text-muted-foreground"
            aria-hidden
          />
        )}
        <button
          type="button"
          className="agent-request-close"
          aria-label={
            isPlan
              ? zh
                ? "取消"
                : "Cancel"
              : zh
                ? "取消请求"
                : "Cancel request"
          }
          title={
            isPlan
              ? zh
                ? "取消"
                : "Cancel"
              : zh
                ? "取消请求"
                : "Cancel request"
          }
          disabled={disabled || submitting}
          onClick={() => void reply("cancel")}
        >
          <X size={19} aria-hidden="true" />
        </button>
        <span role="status" className="sr-only">
          {submitting
            ? zh
              ? "正在提交"
              : "Submitting…"
            : zh
              ? "等待确认"
              : "Needs your input"}
        </span>
      </header>
      <fieldset
        disabled={disabled || submitting}
        className="agent-request-fields"
      >
        <div className="agent-request-body space-y-3">
          {isPlan && interaction.request.plan && (
            <PlanDetails
              plan={interaction.request.plan}
              zh={zh}
              showTitle={
                interaction.request.plan.title !== interaction.request.title
              }
            />
          )}
          {paginated && (
            <p
              className="text-xs text-muted-foreground"
              aria-live="polite"
              aria-atomic="true"
            >
              {zh
                ? `第 ${questionIndex + 1} / ${questions.length} 题`
                : `Question ${questionIndex + 1} of ${questions.length}`}
            </p>
          )}
          {visibleQuestions.map((question) => (
            <fieldset
              key={question.id}
              ref={paginated ? questionRef : undefined}
              tabIndex={paginated ? -1 : undefined}
              aria-describedby={
                errors[question.id]
                  ? `${formId}-${question.id}-error`
                  : undefined
              }
            >
              <legend className="agent-request-label">
                <AskMarkdown content={question.label} />
                {question.required ? (
                  <span className="agent-request-required">*</span>
                ) : null}
              </legend>
              {questionInput(question)}
              {errors[question.id] && (
                <p
                  id={`${formId}-${question.id}-error`}
                  className="mt-1 text-xs text-danger"
                >
                  {errors[question.id]}
                </p>
              )}
            </fieldset>
          ))}
        </div>
        <footer className="agent-request-footer">
          {isPlan && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {zh
                ? "确认后按计划开始工作。你也可以在下方输入修改意见。"
                : "Start working from this plan, or write your changes in the composer."}
            </p>
          )}
          <div className="agent-request-footer-actions">
            {paginated && (
              <button
                type="button"
                className={buttonClass}
                disabled={questionIndex === 0}
                onClick={() => {
                  setErrors({});
                  setQuestionIndex((index) => index - 1);
                }}
              >
                {zh ? "上一步" : "Previous"}
              </button>
            )}
            {isPlan && (
              <button
                type="button"
                className={buttonClass}
                onClick={() => void reply("cancel")}
              >
                {zh ? "暂不执行" : "Not now"}
              </button>
            )}
            {!isPlan && (
              <button
                type="button"
                className={`${buttonClass} agent-request-skip`}
                onClick={() => void reply("decline")}
              >
                {zh ? "跳过" : "Skip"}
              </button>
            )}
            <button
              type={isPlan ? "button" : "submit"}
              className={`${buttonClass} agent-request-primary`}
              onClick={isPlan ? () => void reply("execute") : undefined}
            >
              {isPlan
                ? zh
                  ? "开始执行"
                  : "Start execution"
                : hasNextQuestion
                  ? zh
                    ? "下一步"
                    : "Next"
                  : zh
                    ? "提交回答"
                    : "Submit answers"}
              {isPlan && <ArrowUpRight size={14} aria-hidden />}
            </button>
          </div>
          {Object.keys(errors).length > 0 && (
            <p role="alert" className="text-xs text-danger">
              {zh
                ? "请检查上方标记的字段。"
                : "Check the highlighted fields above."}
            </p>
          )}
          {serverError && (
            <div role="alert" className="space-y-1 text-xs text-danger">
              <p className="break-words">{serverError}</p>
              <button
                type="button"
                className={buttonClass}
                onClick={() => void refreshInteractions(interaction.sessionId)}
              >
                {zh ? "重新加载请求" : "Reload requests"}
              </button>
            </div>
          )}
        </footer>
      </fieldset>
    </form>
  );
}

function InteractionHistory({
  interaction,
  zh,
}: {
  interaction: AgentInteraction;
  zh: boolean;
}) {
  const session = useAgentSessionStore((s) =>
    s.sessions.find((item) => item.id === interaction.sessionId),
  );
  const sendSessionMessage = useAgentSessionStore((s) => s.sendSessionMessage);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const [startError, setStartError] = useState("");
  const currentPlan = session?.sessionMetadata?.plan;
  const canExecute = Boolean(
    interaction.request.plan &&
    currentPlan?.revision === interaction.revision &&
    currentPlan.status === "saved" &&
    session &&
    ["completed", "interrupted", "failed", "idle"].includes(session.status),
  );
  const execute = async () => {
    if (!canExecute || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setStartError("");
    try {
      await sendSessionMessage(interaction.sessionId, {
        message: zh
          ? `执行已保存的计划 v${interaction.revision}：${interaction.request.title}。`
          : `Execute saved plan v${interaction.revision}: ${interaction.request.title}.`,
      });
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };
  const reply = interaction.response;
  const action = reply?.action;
  const tone =
    action === "save"
      ? "saved"
      : action === "revise"
        ? "revision"
        : action === "execute"
          ? "executing"
          : interaction.status === "declined"
            ? "declined"
            : interaction.status === "cancelled"
              ? "cancelled"
              : "answered";
  const status =
    action === "save"
      ? zh
        ? "已保存，可稍后执行"
        : "Saved for later execution"
      : action === "revise"
        ? zh
          ? "已请求修改"
          : "Revision requested"
        : action === "execute"
          ? zh
            ? "已开始执行"
            : "Execution started"
          : interaction.status === "declined"
            ? zh
              ? "已拒绝"
              : "Declined"
            : interaction.status === "cancelled"
              ? interaction.request.plan
                ? zh
                  ? "暂不执行"
                  : "Deferred"
                : zh
                  ? "已取消"
                  : "Cancelled"
              : zh
                ? "已回答"
                : "Answered";
  const summaryLabel = `${interaction.request.title} v${interaction.revision} — ${status}`;
  return (
    <details
      className="agent-history-item agent-interaction-record"
      data-tone={tone}
      open={interaction.kind === "clarification" ? true : undefined}
    >
      <summary aria-label={summaryLabel}>
        <span className="agent-interaction-icon" aria-hidden>
          {interaction.kind === "plan_approval" ? (
            <ListTodo size={16} />
          ) : (
            <MessageCircle size={16} />
          )}
        </span>
        <span className="agent-history-item-title">
          {interaction.request.title}
        </span>
        <span className="agent-history-version">v{interaction.revision}</span>
        <ChevronRight
          size={12}
          aria-hidden
          className="agent-history-item-arrow"
        />
        <span className="agent-history-status" data-tone={tone}>
          <span className="agent-history-status-dot" aria-hidden />
          {status}
        </span>
      </summary>
      <div className="agent-history-detail">
        {interaction.request.plan && (
          <PlanDetails
            plan={interaction.request.plan}
            zh={zh}
            showTitle={false}
          />
        )}
        <dl className="agent-history-answers">
          {interaction.request.questions?.map((question) => {
            const value = reply?.answers?.[question.id];
            return (
              <div key={question.id} className="agent-history-answer">
                <dt>{question.label}</dt>
                <dd>
                  {value === undefined
                    ? "—"
                    : Array.isArray(value)
                      ? value
                          .map(
                            (item) =>
                              question.options?.find(
                                (option) => option.value === item,
                              )?.label ?? item,
                          )
                          .join(", ")
                      : typeof value === "boolean"
                        ? value
                          ? zh
                            ? "是"
                            : "Yes"
                          : zh
                            ? "否"
                            : "No"
                        : (question.options?.find(
                            (option) => option.value === value,
                          )?.label ?? String(value))}
                </dd>
              </div>
            );
          })}
        </dl>
        {canExecute && (
          <div className="agent-saved-plan-actions">
            <span>{zh ? "准备好后，随时开始。" : "Ready when you are."}</span>
            <button
              type="button"
              className={`${buttonClass} agent-request-primary`}
              disabled={starting}
              onClick={() => void execute()}
            >
              {starting && <Loader2 size={13} className="animate-spin" />}
              {zh ? "开始执行" : "Start execution"}
              <ArrowUpRight size={14} />
            </button>
          </div>
        )}
        {startError && (
          <p role="alert" className="text-xs text-danger">
            {startError}
          </p>
        )}
        {reply?.message && (
          <p className="agent-history-message">{reply.message}</p>
        )}
      </div>
    </details>
  );
}

export function InteractionCard({
  interaction,
  disabled = false,
}: {
  interaction: AgentInteraction;
  disabled?: boolean;
}) {
  const { locale } = useLocale();
  return (
    <article
      className="session-inline-interaction"
      id={`interaction-${interaction.id}`}
      tabIndex={-1}
    >
      {interaction.status === "pending" ? (
        <InteractionForm
          key={`${interaction.id}:${interaction.revision}`}
          interaction={interaction}
          disabled={disabled}
        />
      ) : (
        <InteractionHistory interaction={interaction} zh={locale === "zh"} />
      )}
    </article>
  );
}

export function AgentInteractionPanel({
  session,
  compact = false,
  dock = false,
}: {
  session: AgentSession;
  compact?: boolean;
  dock?: boolean;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const state = useAgentSessionStore((s) => s.interactionState);
  const selectedSessionId = useAgentSessionStore((s) => s.selectedSessionId);
  const refreshInteractions = useAgentSessionStore(
    (s) => s.refreshInteractions,
  );
  // Compact hosts render jump pills; the composer dock renders pending
  // clarification cards in place of the free-text composer.
  const [jumpTargetId, setJumpTargetId] = useState<string | null>(null);
  const acp = readSessionBackendId(session).endsWith("-acp");

  useEffect(() => {
    if (!acp && selectedSessionId === session.id)
      void refreshInteractions(session.id);
  }, [
    acp,
    selectedSessionId,
    session.id,
    session.status,
    session.updatedAt,
    refreshInteractions,
  ]);

  useEffect(() => {
    if (acp) return;
    // Event-driven refreshes never fetch inline: they join the workspace's
    // single coalescing scheduler, so a burst of runtime events — a running
    // step, or the teardown of this very session — costs one trailing fetch
    // instead of one per event. List reconciliation is useRuntimeSSE's job.
    const schedule = () => scheduleSessionRefresh(session.id, "interactions");
    const onEvent = (event: MessageEvent) => {
      try {
        if (
          (JSON.parse(event.data) as { sessionId?: string }).sessionId ===
          session.id
        )
          schedule();
      } catch {
        /* Ignore malformed notifications; durable HTTP state is authoritative. */
      }
    };
    return subscribe({
      onConnect: schedule,
      events: { session_changed: onEvent, session_step_completed: onEvent },
    });
  }, [acp, session.id]);

  const findInteractionTarget = useCallback((itemId: string) => {
    const card = document.getElementById(`interaction-${itemId}`);
    return (
      card ??
      document.getElementById(`session-entry-interaction-${itemId}`) ??
      null
    );
  }, []);

  // Keep the pill aligned with its card while the reader scrolls, and show that
  // the interaction is still pending after the click-triggered re-render.
  useEffect(() => {
    if (!jumpTargetId) return;
    const sync = () => {
      const target = findInteractionTarget(jumpTargetId);
      setJumpTargetId((previous) =>
        previous === jumpTargetId
          ? target && target.isConnected
            ? jumpTargetId
            : null
          : previous,
      );
    };
    const frame = window.requestAnimationFrame(sync);
    const timer = window.setTimeout(sync, 600);
    window.addEventListener("scroll", sync, true);
    window.addEventListener("resize", sync);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      window.removeEventListener("scroll", sync, true);
      window.removeEventListener("resize", sync);
    };
  }, [
    jumpTargetId,
    findInteractionTarget,
    session.id,
    session.updatedAt,
    state,
  ]);

  const revealInteraction = useCallback(
    (itemId: string) => {
      setJumpTargetId(itemId);
      const target = findInteractionTarget(itemId);
      if (!target) {
        // The transcript card is not mounted yet; reload so the reader is not
        // left staring at an empty dock after the click.
        void refreshInteractions(session.id);
        return;
      }
      try {
        target.scrollIntoView({
          block: "center",
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
      } catch {
        /* Older engines lack scroll options; an unanimated jump is fine. */
        target.scrollIntoView();
      }
      // Animate only the transcript above the dock, so the pill never leaves the
      // viewport while the card is being revealed.
      target.focus?.({ preventScroll: true });
    },
    [findInteractionTarget, refreshInteractions, session.id],
  );

  if (acp) return null;
  const current = state?.sessionId === session.id ? state : null;
  const pending =
    current?.items.filter((item) => item.status === "pending") ?? [];
  const dockPending = pending.filter((item) => item.kind === "clarification");
  const waiting = session.status === "waiting_input" || pending.length > 0;
  const items = current?.items ?? [];
  if (dock && !current?.error && !dockPending.length) return null;
  if (
    !dock &&
    !waiting &&
    !current?.error &&
    (compact || !items.length)
  )
    return null;
  return (
    <section
      aria-label={zh ? "待处理请求" : "Agent requests"}
      className={`agent-controls-stack${dock ? " agent-controls-stack--dock" : ""}`}
    >
      {current?.error && (
        <div role="alert" className="agent-interaction-error">
          <p>{current.error}</p>
          <button
            type="button"
            className={buttonClass}
            onClick={() => void refreshInteractions(session.id)}
          >
            {zh ? "重新加载" : "Retry loading"}
          </button>
        </div>
      )}
      {waiting && pending.length === 0 && (
        <p role="status" className="px-2 text-xs text-muted-foreground">
          {zh ? "正在加载提问…" : "Loading requests…"}
        </p>
      )}
      {dock
        ? dockPending.map((item) => (
            <InteractionCard
              key={`${item.id}:${item.revision}`}
              interaction={item}
              disabled={session.status === "cancelled"}
            />
          ))
        : compact
        ? pending.map((item) => {
            const jumping = jumpTargetId === item.id;
            return (
            <button
              key={item.id}
              type="button"
              className="agent-pending-jump"
              data-jumping={jumping ? "true" : undefined}
              aria-expanded={jumping}
              onClick={() => revealInteraction(item.id)}
            >
              <MessageCircle size={14} />
              <span>
                {item.kind === "plan_approval"
                  ? zh
                    ? "计划待确认"
                    : "Plan ready for review"
                  : zh
                    ? "有问题需要你回答"
                    : "Your input is needed"}
              </span>
              {jumping ? <ArrowUpRight size={14} /> : <ArrowDown size={14} />}
            </button>
            );
          })
        : items.map((item) => (
            <InteractionCard
              key={`${item.id}:${item.revision}`}
              interaction={item}
              disabled={session.status === "cancelled"}
            />
          ))}
    </section>
  );
}
