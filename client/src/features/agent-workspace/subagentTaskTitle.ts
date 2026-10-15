import { activityPreview } from "./activityText";

/** Section headings the runtime adds around a delegated prompt. */
const DELEGATION_ENVELOPE = /^\s*#{0,6}\s*Subagent delegation context\b/i;
const DELEGATED_TASK_HEADING = /^\s*#{0,6}\s*Delegated task\s*$/im;
const INVESTIGATION_TASK_HEADING = /^\s*#{0,6}\s*Investigation Task\b/i;
const PLAYBOOK_SECTION = /^\s*#{0,6}\s*(?:Explorer|Reviewer) Playbook\b/i;

/** Sections that describe the child's behaviour, never the delegated question. */
const PROMPT_SCAFFOLDING = [DELEGATION_ENVELOPE, INVESTIGATION_TASK_HEADING, PLAYBOOK_SECTION];

const isDelegationEnvelope = (value: string) => DELEGATION_ENVELOPE.test(value);

/**
 * The runtime wraps a delegated prompt in fixed sections: the delegation
 * context, `## Investigation Task` (explorer playbook) and `## Explorer
 * Playbook`. Only the section that carries the actual question is a title;
 * everything else would surface a constant heading such as
 * "Investigation Task" as the task summary.
 */
function delegatedTaskText(value: string): string {
  const envelope = value.split(DELEGATED_TASK_HEADING);
  const task = envelope.length > 1 ? envelope.slice(1).join("\n") : value;
  const lines = task.split("\n");
  const carried: string[] = [];
  for (const line of lines) {
    if (PROMPT_SCAFFOLDING.some((pattern) => pattern.test(line))) {
      // The playbook is the tail of the prompt: everything after it is
      // instructions for the child, not part of the question.
      if (PLAYBOOK_SECTION.test(line)) break;
      continue;
    }
    carried.push(line);
  }
  return carried.join("\n").trim();
}

/**
 * The task a delegated child is actually working on. Shared by the transcript
 * card and the subagent island so both report the same line.
 */
export function subagentTaskTitle(
  session: { title?: string | null; prompt: string; profileId?: string },
  locale = "zh",
): string {
  const title = session.title?.trim();
  if (title && !isDelegationEnvelope(title)) {
    const fromTitle = delegatedTaskText(title);
    if (fromTitle) return activityPreview(fromTitle);
  }
  const task = delegatedTaskText(session.prompt.trim());
  if (task) return activityPreview(task).replace(/^#+\s*/, "");
  return locale === "zh"
    ? session.profileId === "explorer" ? "探索任务" : "委派任务"
    : session.profileId === "explorer" ? "Exploration task" : "Delegated task";
}
