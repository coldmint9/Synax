import type { CodeModeSettings } from "../../../infrastructure/runtime/config/project-settings-types.js";
import { getProjectSettings } from "../../../infrastructure/runtime/config/project-settings-store.js";
import { CUA_SERVER_ID } from "../../../infrastructure/mcp/runtime-cua-config.js";
import type { AgentSession, RegisteredTool } from "../contracts.js";

export const CODE_TOOL_IDS = new Set(["code.tools", "code.run"]);
const LOCAL_COMPOSITION_TOOLS = new Set([
  "file.read",
  "file.list",
  "rg",
  "diff.read",
  "context.read",
  "file.write",
  "file.patch",
]);
export function codeModeEnabled(
  session: AgentSession,
  _settings?: CodeModeSettings,
): boolean {
  const backend = session.sessionMetadata?.backend as
    | { id?: string }
    | undefined;
  if (
    (backend?.id && backend.id !== "native") ||
    (!backend && Boolean(session.sessionMetadata?.acp))
  )
    return false;
  return true;
}
export function canComposeTool(
  session: AgentSession,
  tool: Omit<RegisteredTool, "execute">,
  settings?: CodeModeSettings,
): boolean {
  const config = settings ?? getProjectSettings(session.projectId).codeMode;
  if (!codeModeEnabled(session, config))
    return false;
  if (LOCAL_COMPOSITION_TOOLS.has(tool.id)) return true;
  // A server-supplied readOnlyHint alone is not a trust boundary. Require an
  // administrator's exact per-project opt-in as well as the provider's marker.
  return (
    tool.category === "mcp" &&
    tool.mutability === "read" &&
    tool.codeModeReadOnly === true &&
    !tool.id.startsWith(`mcp.${CUA_SERVER_ID}.`) &&
    (config?.mcpTools ?? []).includes(tool.id)
  );
}
