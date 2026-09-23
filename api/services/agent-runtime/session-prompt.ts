import { buildSessionUserMessage } from "./session-user-request.js";
import { buildLanguageDirective } from "../prompts/language-directive.js";

export type SessionPromptMode = "session" | "direct" | "plan_node";
export type SessionWikiAttachMode = "auto" | "manual";

export type SessionReferenceAnchor = {
  type: "heading" | "selection";
  heading?: string;
  quote?: string;
};

/** Prompt data only: the runtime does not depend on the Wiki persistence model. */
export type LinkedGoalPromptContext = {
  id: string;
  content: string;
  scope: "project" | "document";
  anchorJson: SessionReferenceAnchor | null;
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
  documentTitle?: string | null;
  documentId?: string | null;
  anchorJson?: SessionReferenceAnchor | null;
  wikiAttachMode?: SessionWikiAttachMode;
  wikiAutoMatched?: boolean;
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
    documentTitle?: string | null;
    documentId?: string | null;
    anchorJson?: SessionReferenceAnchor | null;
    wikiAttachMode?: SessionWikiAttachMode;
    wikiAutoMatched?: boolean;
  },
  locale: "zh" | "en",
): string {
  const lines: string[] = [
    buildLanguageDirective(locale),
    "",
    "## User Goal",
    input.content.trim(),
  ];

  const wikiMode = input.wikiAttachMode ?? "manual";

  if (input.documentId || input.documentTitle) {
    lines.push(
      "",
      wikiMode === "auto" && input.wikiAutoMatched
        ? "## Wiki Context (auto-matched)"
        : "## Wiki Context",
    );
    if (wikiMode === "auto" && input.wikiAutoMatched) {
      lines.push("- Matched automatically from goal intent.");
    }
    if (input.documentTitle) lines.push(`- Document: ${input.documentTitle}`);
    if (input.documentId) lines.push(`- Document ID: ${input.documentId}`);
    if (input.anchorJson) {
      appendAnchorLines(lines, input.anchorJson);
    }
    lines.push(
      "- Keep wiki documentation aligned when you change related code.",
    );
  } else if (wikiMode === "auto") {
    lines.push(
      "",
      "## Wiki Context (auto)",
      "- No specific wiki document matched automatically.",
      "- Infer related design context from the codebase and keep wiki aligned when you change related areas.",
    );
  }

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
      const anchor = g.anchorJson
        ? `\n- Anchor: ${g.anchorJson.type}${g.anchorJson.heading ? ` §${g.anchorJson.heading}` : ""}${g.anchorJson.quote ? ` "${g.anchorJson.quote.slice(0, 120)}"` : ""}`
        : "";
      return `### Goal ${i + 1} [${g.id}]
- Content: ${g.content}
- Scope: ${g.scope}${anchor}`;
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
    "2. Use edit for targeted edits; file.write only for new files.",
    "3. Prefer expected files; explain clearly if you must go outside that scope.",
    "4. Do not update wiki documentation — wiki refresh runs after the full plan completes.",
    "5. You may use shell to run tests and verify changes.",
    "6. End with a structured summary: what changed and how to verify.",
  ].join("\n");
}

function appendAnchorLines(
  lines: string[],
  anchor: SessionReferenceAnchor,
): void {
  if (anchor.type === "heading" && anchor.heading) {
    lines.push(`- Anchor heading: ${anchor.heading}`);
  }
  if (anchor.quote) {
    lines.push(`- Selected quote: "${anchor.quote.slice(0, 300)}"`);
  }
}
