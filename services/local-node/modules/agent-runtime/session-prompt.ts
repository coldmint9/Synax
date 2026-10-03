import { buildSessionUserMessage } from "./session-user-request.js";
import { buildLanguageDirective } from "../prompts/language-directive.js";

export type SessionPromptMode = "session" | "direct" | "plan_node";

export type SessionReferenceAnchor = {
  type: "heading" | "selection";
  heading?: string;
  quote?: string;
};

/** Prompt data only for session and plan execution. */
export type LinkedGoalPromptContext = {
  id: string;
  content: string;
  scope: "project";
};

export type PlanNodePromptContext = {
  title: string;
  description: string;
  expectedFiles: string[];
  dependsOn: string[];
};

export type CompletedNodePromptContext = {
  title: string;
  summary?: string;
};

export function buildSessionPrompt(input: {
  mode?: SessionPromptMode;
  content: string;
  node?: PlanNodePromptContext;
  linkedGoals?: LinkedGoalPromptContext[];
  completedNodes?: CompletedNodePromptContext[];
  redoFeedback?: string;
  locale?: "zh" | "en";
}): string {
  if (input.mode === "session") return buildSessionUserMessage(input);
  const mode = input.mode ?? "direct";
  const locale = input.locale ?? "zh";

  if (mode === "plan_node") {
    return buildPlanNodePrompt(input, locale);
  }
  return buildDirectPrompt(input, locale);
}

function buildDirectPrompt(
  input: {
    content: string;
            },
  locale: "zh" | "en",
): string {
  const lines: string[] = [
    buildLanguageDirective(locale),
    "",
    "## User Goal",
    input.content.trim(),
  ];


  lines.push(
    "",
    "## Instructions",
    "- Investigate the codebase, implement the goal, and verify your changes.",
    "- Prefer minimal, focused diffs. Explain blockers clearly if you cannot finish.",
  );

  return lines.join("\n");
}

function buildPlanNodePrompt(
  input: {
    content: string;
    node?: PlanNodePromptContext;
    linkedGoals?: LinkedGoalPromptContext[];
    completedNodes?: CompletedNodePromptContext[];
    redoFeedback?: string;
  },
  locale: "zh" | "en",
): string {
  const node = input.node;
  const goalDetails = (input.linkedGoals ?? [])
    .map((g, i) => {
      const anchor = "";
      return `### Goal ${i + 1} [${g.id}]
- Content: ${g.content}
- Scope: ${g.scope}`;
    })
    .join("\n\n");

  const files =
    node && node.expectedFiles.length > 0
      ? node.expectedFiles.map((f) => `- ${f}`).join("\n")
      : "- (infer from description)";

  const completed =
    (input.completedNodes ?? []).length > 0
      ? input
          .completedNodes!.map(
            (n) => `- ${n.title}${n.summary ? `: ${n.summary}` : ""}`,
          )
          .join("\n")
      : "- (none)";

  const feedbackBlock = input.redoFeedback
    ? `\n## Redo Feedback\n${input.redoFeedback}\n`
    : "";

  return [
    buildLanguageDirective(locale),
    "You are Synax executing a single plan node (plan_node mode). Implement the node by making real code changes in the workspace.",
    "",
    "## Plan Node",
    `- **Title**: ${node?.title ?? input.content}`,
    `- **Description**: ${node?.description ?? input.content}`,
    "",
    "## Linked Goals",
    goalDetails || "(none)",
    "",
    "## Completed Dependencies",
    completed,
    "",
    "## Expected Files (write scope)",
    files,
    feedbackBlock,
    "## Rules",
    "1. Read relevant code with rg and file.read before writing.",
    "2. Use file.patch for edits; file.write only for complete new files.",
    "3. Prefer expected files; explain clearly if you must go outside that scope.",
    "4. Keep changes within the requested scope and verify them before finishing.",
    "5. You may use shell to run tests and verify changes.",
    "6. End with a structured summary: what changed and how to verify.",
  ].join("\n");
}

