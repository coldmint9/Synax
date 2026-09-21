import type {
  ArtifactControl,
  ArtifactRevision,
  ArtifactState,
} from "../../../../api/services/agent-runtime/artifacts/contracts";
import { apiRequest } from "./origin";
// Environment-neutral wire shapes live here; do not import the DB-bearing service in Web.
export interface ArtifactControlSchema {
  schemaVersion: number;
  controls: ArtifactControl[];
}
export interface ArtifactVersionHistory {
  revisions: ArtifactRevision[];
  derivedFrom: ArtifactRevision | null;
  branches: ArtifactRevision[];
}
export interface ForkArtifactVersionInput {
  title: string;
  idempotencyKey: string;
}
export interface InheritArtifactStateInput {
  sourceRevisionId: string;
  sourceEtag: number;
  expectedEtag: number;
  includePrivateState: boolean;
  includeModelState: boolean;
  confirmSensitiveState: boolean;
}
export interface StateInheritanceInspection {
  compatible: boolean;
  reason: string | null;
  sourceRevisionId: string;
  targetRevisionId: string;
  sourceEtag: number;
  expectedEtag: number;
  controlKeys: string[];
}
const base = (sessionId: string) =>
  `/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/artifacts`;
const revision = (sessionId: string, revisionId: string) =>
  `${base(sessionId)}/revisions/${encodeURIComponent(revisionId)}`;
const action = (name: string) => ({
  "Content-Type": "application/json",
  "X-Synax-Artifact-Action": name,
});
export const artifactVersionsApi = {
  history: (sessionId: string, artifactId: string) =>
    apiRequest<ArtifactVersionHistory>(
      `${base(sessionId)}/${encodeURIComponent(artifactId)}/versions`,
      { silent: true },
    ),
  registerControlSchema: (
    sessionId: string,
    revisionId: string,
    schema: ArtifactControlSchema,
  ) =>
    apiRequest<{ schema: ArtifactControlSchema; state: ArtifactState }>(
      `${revision(sessionId, revisionId)}/control-schema`,
      {
        method: "PUT",
        headers: action("register-control-schema"),
        body: JSON.stringify(schema),
        silent: true,
      },
    ),
  controlSchema: (sessionId: string, revisionId: string) =>
    apiRequest<{ schema: ArtifactControlSchema | null }>(
      `${revision(sessionId, revisionId)}/control-schema`,
      { silent: true },
    ),
  fork: (
    sessionId: string,
    revisionId: string,
    input: ForkArtifactVersionInput,
  ) =>
    apiRequest<{ revision: ArtifactRevision }>(
      `${revision(sessionId, revisionId)}/fork`,
      {
        method: "POST",
        headers: action("confirm-fork"),
        body: JSON.stringify(input),
        silent: true,
      },
    ),
  inspectInheritance: (
    sessionId: string,
    targetRevisionId: string,
    sourceRevisionId: string,
  ) =>
    apiRequest<StateInheritanceInspection>(
      `${revision(sessionId, targetRevisionId)}/inheritance?sourceRevisionId=${encodeURIComponent(sourceRevisionId)}`,
      { silent: true },
    ),
  inheritState: (
    sessionId: string,
    targetRevisionId: string,
    input: InheritArtifactStateInput,
  ) =>
    apiRequest<ArtifactState>(
      `${revision(sessionId, targetRevisionId)}/inherit-state`,
      {
        method: "POST",
        headers: action("confirm-inherit-state"),
        body: JSON.stringify(input),
        silent: true,
      },
    ),
};
