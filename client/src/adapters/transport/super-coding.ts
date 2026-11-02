import { apiRequest } from "./origin";
import type {
  SuperChannelResponse,
  SuperCommand,
  SuperCommandResult,
  SuperSnapshotResponse,
} from "../../../../packages/contracts/super-coding";

const base = (sessionId: string) =>
  `/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/super`;

/**
 * Super orchestration transport. The card never calls fetch directly: this is
 * the only place that knows the URLs and response shapes.
 */
export const superCodingApi = {
  getGraph: (sessionId: string) =>
    apiRequest<SuperSnapshotResponse>(base(sessionId), { silent: true }),

  getChannel: (sessionId: string, nodeId: string) =>
    apiRequest<SuperChannelResponse>(
      `${base(sessionId)}/channels/${encodeURIComponent(nodeId)}/messages`,
      { silent: true },
    ),

  sendCommand: (sessionId: string, command: SuperCommand) =>
    apiRequest<SuperCommandResult>(`${base(sessionId)}/commands`, {
      method: "POST",
      body: JSON.stringify(command),
      silent: true,
    }),
};
