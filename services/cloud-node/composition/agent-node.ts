import { createAgentNode } from "../../shared/agent-node.js";

export const cloudAgentNode = createAgentNode(
  { nodeId: "cloud-node", kind: "cloud", protocolVersion: "1" },
  { read: "allow", write: "deny", execute: "deny", admin: "deny" },
);
