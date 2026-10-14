import { activityPreview } from "./activityText";

/** Older sessions persist the delegation envelope as their prompt/title. */
export function subagentTaskTitle(
  session: { title?: string | null; prompt: string; profileId?: string },
  locale = "zh",
): string {
  const title = session.title?.trim();
  const isEnvelope = (value: string) => /^#{0,6}\s*Subagent delegation context\b/i.test(value);
  if (title && !isEnvelope(title)) return activityPreview(title);
  const prompt = session.prompt.trim();
  const task = isEnvelope(prompt)
    ? prompt.split(/^## Delegated task\s*$/m).slice(1).join("\n").trim()
    : prompt;
  if (task) return activityPreview(task).replace(/^#+\s*/, "");
  return locale === "zh"
    ? session.profileId === "explorer" ? "探索任务" : "委派任务"
    : session.profileId === "explorer" ? "Exploration task" : "Delegated task";
}
