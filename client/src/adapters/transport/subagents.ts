import { apiRequest } from "./origin";
import type { CustomSubagent, CustomSubagentInput } from "../../../../services/local-node/modules/agent-runtime/subagent-config";
export type { CustomSubagent, CustomSubagentInput };
const base = "/api/agent-runtime/subagent-templates";
export const subagentsApi = {
  list: () => apiRequest<{ items: CustomSubagent[] }>(base),
  create: (input: CustomSubagentInput) => apiRequest<{ item: CustomSubagent }>(base, { method: "POST", body: JSON.stringify(input) }),
  update: (id: string, input: CustomSubagentInput) => apiRequest<{ item: CustomSubagent }>(`${base}/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }),
  remove: (id: string) => apiRequest<{ ok: boolean }>(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
