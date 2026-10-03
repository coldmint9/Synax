import { createAgentNode } from "../../shared/agent-node.js";
import { defaultLocalCapabilityPolicy } from "../../../packages/capabilities/index.js";

export const localAgentNode = createAgentNode(
  { nodeId: "local-node", kind: "local", protocolVersion: "1" },
  defaultLocalCapabilityPolicy,
);
