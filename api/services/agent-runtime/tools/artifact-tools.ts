import { outsideExecutionContext } from "../../../lib/execution-context.js";
import {
  enqueueArtifactJob,
  getArtifactJob,
  cancelArtifactJob,
  processArtifactJobs,
} from "../artifact-jobs.js";
import { getArtifactBundle } from "../artifacts/publisher.js";
import { ArtifactError } from "../artifacts/contracts.js";
import { z } from "zod";
import type { RegisteredTool } from "../contracts.js";
import { publishArtifactSchema } from "../artifact-manifest.js";
import {
  listArtifacts,
  getArtifactSource,
  listRevisions,
} from "../artifacts/publisher.js";
export const artifactTools: RegisteredTool[] = [
  {
    id: "artifact.publish",
    label: "Publish Interactive Artifact",
    description:
      "Publish an immutable, sandboxed HTML or React prototype in this conversation. Updates require artifactId and baseRevisionId. Writes must be approved; no generated server or build scripts are run.",
    category: "write",
    internalGate: "write",
    mutability: "write",
    resumeBehavior: "wait_permission",
    inputSchema: publishArtifactSchema,
    getPattern(args) {
      return (args as { sourcePath?: string })?.sourcePath;
    },
    async execute(input) {
      const args = publishArtifactSchema.parse(input.args);
      if (input.abortSignal?.aborted) throw new Error("Publication cancelled");
      const queued = enqueueArtifactJob(
        input.sessionId,
        args,
        input.runId,
        input.stepId,
      );
      let job = getArtifactJob(input.sessionId, queued.jobId);
      while (job.status === "queued" || job.status === "building") {
        if (input.abortSignal?.aborted) {
          outsideExecutionContext(() =>
            cancelArtifactJob(input.sessionId, job.jobId),
          );
          throw new ArtifactError(
            "BUILD_CANCELLED",
            "Publication cancelled",
            409,
          );
        }
        void processArtifactJobs().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 50));
        job = getArtifactJob(input.sessionId, job.jobId);
      }
      if (job.status !== "ready" || !job.revisionId)
        throw new ArtifactError(
          job.errorCode ?? "BUILD_FAILED",
          job.diagnostics.join("\n") || "Build failed",
          409,
        );
      const revision = getArtifactBundle(
        input.sessionId,
        job.revisionId,
      ).revision;
      return {
        result: revision,
        displaySummary: `${revision.status}: ${revision.title} v${revision.revisionNumber}`,
        artifacts: [],
      };
    },
  },
  {
    id: "artifact.list",
    label: "List Interactive Artifacts",
    description: "Read interactive artifact versions in the current session.",
    category: "read",
    mutability: "read",
    resumeBehavior: "auto",
    inputSchema: z.object({ artifactId: z.string().optional() }).strict(),
    execute(input) {
      const { artifactId } = input.args as { artifactId?: string };
      return {
        result: {
          items: artifactId
            ? listRevisions(input.sessionId, artifactId)
            : listArtifacts(input.sessionId),
        },
        displaySummary: "Session interactive artifacts",
        artifacts: [],
      };
    },
  },
  {
    id: "artifact.read",
    label: "Read Artifact Source",
    description:
      "Read the immutable source snapshot of an artifact revision in this session.",
    category: "read",
    mutability: "read",
    resumeBehavior: "auto",
    inputSchema: z
      .object({
        revisionId: z.string(),
        path: z.string().optional(),
        offset: z.number().int().min(0).default(0),
        maxCharacters: z.number().int().min(1).max(100000).default(32000),
      })
      .strict(),
    execute(input) {
      const {
        revisionId,
        path,
        offset = 0,
        maxCharacters = 32000,
      } = input.args as {
        revisionId: string;
        path?: string;
        offset?: number;
        maxCharacters?: number;
      };
      let remaining = maxCharacters;
      const files = getArtifactSource(input.sessionId, revisionId)
        .filter((file) => !path || file.path === path)
        .map((file) => {
          if (file.encoding === "base64")
            return {
              path: file.path,
              mediaType: file.mediaType,
              binary: true,
              bytes: Buffer.byteLength(file.content, "base64"),
            };
          const content = file.content.slice(offset, offset + remaining);
          remaining -= content.length;
          return {
            ...file,
            content,
            offset,
            totalCharacters: file.content.length,
            truncated: offset + content.length < file.content.length,
          };
        });
      return {
        result: { files },
        displaySummary: "Artifact source snapshot",
        artifacts: [],
      };
    },
  },
];
