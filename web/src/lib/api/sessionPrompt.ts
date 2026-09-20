import { apiFetch } from "./origin";

export type SessionPromptAnchor = {
  type: "heading" | "selection";
  heading?: string;
  quote?: string;
};

export type SessionPromptInput = {
  mode?: "session" | "direct" | "plan_node";
  content: string;
  wikiAttachMode?: "auto" | "manual";
  documentId?: string | null;
  documentTitle?: string | null;
  anchorJson?: SessionPromptAnchor | null;
  locale?: "zh" | "en";
};

export type SessionPromptResult = {
  prompt: string;
  wikiContext: {
    mode: "auto" | "manual";
    documentId: string | null;
    documentTitle: string | null;
    anchorJson: SessionPromptAnchor | null;
    autoMatched: boolean;
  };
};

export const sessionPromptApi = {
  async build(
    projectId: string,
    body: SessionPromptInput,
  ): Promise<SessionPromptResult> {
    const res = await apiFetch(
      `/api/wiki/projects/${projectId}/session-prompt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`session-prompt failed: ${res.status}`);
    return res.json() as Promise<SessionPromptResult>;
  },
};
