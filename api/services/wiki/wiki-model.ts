import { getGlobalConfig } from "../../lib/config/config-store.js";

/** Read at invocation time so new Wiki runs use the saved setting in API and worker processes. */
export function getWikiWorkflowModel(): string | undefined {
  return getGlobalConfig().wikiModel?.trim() || undefined;
}
