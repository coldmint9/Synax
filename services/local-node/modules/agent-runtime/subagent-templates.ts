import { businessStore } from "../../infrastructure/persistence/business-store.js";
import { customSubagentSchema, type CustomSubagent, type CustomSubagentInput } from "./subagent-config.js";
import { AgentNotFoundError, AgentValidationError } from "./runtime-errors.js";
import { makeRuntimeId, nowIso } from "./runtime-ids.js";

export const subagentTemplates = {
  list(): CustomSubagent[] {
    return businessStore.list<CustomSubagent>("subagent-templates").sort((a, b) => a.name.localeCompare(b.name));
  },
  get(id: string): CustomSubagent {
    const value = businessStore.get<CustomSubagent>("subagent-templates", id);
    if (!value) throw new AgentNotFoundError(id);
    return value;
  },
  save(input: CustomSubagentInput, id?: string): CustomSubagent {
    const config = customSubagentSchema.parse(input);
    const previous = id ? this.get(id) : undefined;
    if (!id && this.list().length >= 100) throw new AgentValidationError("Up to 100 custom subagents are supported.");
    const now = nowIso();
    const value = { ...config, id: id ?? makeRuntimeId("sub"), createdAt: previous?.createdAt ?? now, updatedAt: now };
    businessStore.put("subagent-templates", value.id, value);
    return value;
  },
  remove(id: string): void {
    this.get(id);
    businessStore.delete("subagent-templates", id);
  },
};
