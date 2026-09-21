import type {
  ArtifactBundle,
  ArtifactBuildJob,
  ArtifactFeedbackInput,
  ArtifactFile,
  ArtifactPublishInput,
  ArtifactRevision,
  ArtifactState,
} from "../../../../api/services/agent-runtime/artifacts/contracts";
import { apiFetch, apiRequest } from "./origin";
const base = (sessionId: string) =>
  `/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/artifacts`;
const revision = (sessionId: string, revisionId: string) =>
  `${base(sessionId)}/revisions/${encodeURIComponent(revisionId)}`;
export interface ArtifactFeedbackResult {
  feedbackId: string;
  message: string;
  submitted: boolean;
}
export const artifactsApi = {
  list: (sessionId: string) =>
    apiRequest<{ items: ArtifactRevision[] }>(base(sessionId), {
      silent: true,
    }),
  publish: (sessionId: string, input: ArtifactPublishInput) =>
    apiRequest<{ job: ArtifactBuildJob }>(base(sessionId), {
      method: "POST",
      body: JSON.stringify(input),
      silent: true,
    }),
  revisions: (sessionId: string, artifactId: string) =>
    apiRequest<{ items: ArtifactRevision[] }>(
      `${base(sessionId)}/${encodeURIComponent(artifactId)}/revisions`,
      { silent: true },
    ),
  bundle: (sessionId: string, revisionId: string) =>
    apiRequest<ArtifactBundle>(`${revision(sessionId, revisionId)}/bundle`, {
      silent: true,
    }),
  source: (sessionId: string, revisionId: string) =>
    apiRequest<{ files: ArtifactFile[] }>(
      `${revision(sessionId, revisionId)}/source`,
      { silent: true },
    ),
  state: (sessionId: string, revisionId: string) =>
    apiRequest<ArtifactState>(`${revision(sessionId, revisionId)}/state`, {
      silent: true,
    }),
  saveState: (sessionId: string, revisionId: string, state: ArtifactState) =>
    apiRequest<ArtifactState>(`${revision(sessionId, revisionId)}/state`, {
      method: "PUT",
      silent: true,
      body: JSON.stringify({
        privateState: state.privateState,
        modelState: state.modelState,
        controls: state.controls,
        schemaVersion: state.schemaVersion,
        expectedEtag: state.etag,
      }),
    }),
  feedback: (
    sessionId: string,
    revisionId: string,
    input: ArtifactFeedbackInput,
  ) =>
    apiRequest<ArtifactFeedbackResult>(
      `${revision(sessionId, revisionId)}/feedback`,
      {
        method: "POST",
        silent: true,
        headers: {
          "Content-Type": "application/json",
          "X-Synax-Artifact-Action": "confirm-feedback",
        },
        body: JSON.stringify(input),
      },
    ),
  async download(
    sessionId: string,
    revisionId: string,
    format: "html" | "source",
  ): Promise<void> {
    const response = await apiFetch(
      `${revision(sessionId, revisionId)}/export?format=${format}`,
    );
    if (!response.ok)
      throw new Error(`Artifact export failed (${response.status}).`);
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `artifact-${revisionId.replace(/[^\w-]/g, "")}.${format === "html" ? "html" : "zip"}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
