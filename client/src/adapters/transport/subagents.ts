import { apiRequest } from "./origin";
import type { CustomSubagent, CustomSubagentInput } from "../../../../services/local-node/modules/agent-runtime/subagent-config";
export type { CustomSubagent, CustomSubagentInput };
const base = "/api/agent-runtime/subagent-templates";
/**
 * 子代理配置面板会就地展示失败原因（含重试），因此这里不再触发全局 toast，
 * 避免同一次失败既弹浮层又留在表单里。
 */
export const subagentsApi = {
  list: () => apiRequest<{ items: CustomSubagent[] }>(base, { silent: true }),
  create: (input: CustomSubagentInput) => apiRequest<{ item: CustomSubagent }>(base, { method: "POST", body: JSON.stringify(input), silent: true }),
  update: (id: string, input: CustomSubagentInput) => apiRequest<{ item: CustomSubagent }>(`${base}/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input), silent: true }),
  remove: (id: string) => apiRequest<{ ok: boolean }>(`${base}/${encodeURIComponent(id)}`, { method: "DELETE", silent: true }),
};
