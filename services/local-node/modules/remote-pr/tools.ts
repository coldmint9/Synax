import * as z from "zod/v4";
import type { RegisteredTool } from "../agent-runtime/contracts.js";
import { remotePrService } from "./service.js";
const schema = z.object({ objectId: z.string().min(1).max(160) }).strict();
export const remotePrTools: RegisteredTool[] = [
  {
    id: "git.pr.read",
    label: "Read conversation remote PR",
    category: "read",
    internalGate: "none",
    mutability: "read",
    resumeBehavior: "auto",
    description:
      "Read the GitLab MR or GitHub PR already attached to this conversation by the MR button. Returns live branch SHAs, pipeline stages with jobs, approvals, commits, diff totals, merge state and any linked local conflict task. Does not push, create requests or merge. Use the card for user-confirmed remote writes; use git.merge.read/propose on a linked conflict-resolution task.",
    inputSchema: schema,
    async execute(input) {
      const { objectId } = schema.parse(input.args);
      const snapshot = await remotePrService.get(input.sessionId, objectId);
      return {
        result: {
          reference: snapshot.reference,
          task: snapshot.task,
          pr: { ...snapshot.pr, body: snapshot.pr.body.slice(0, 16000) },
          local: snapshot.local,
          resolutionReference: snapshot.resolutionReference,
        },
        displaySummary: `${snapshot.task.repository.provider} #${snapshot.pr.number}: ${snapshot.pr.state}`,
        artifacts: [],
      };
    },
  },
];
