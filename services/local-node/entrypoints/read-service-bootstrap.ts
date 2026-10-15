import { ensureGitMrProfileRegistered } from "../modules/agent-runtime/git/profile.js";
import {
  ensureLegacyGoalProfileRegistered,
  ensureSynaxAgentRegistered,
} from "../modules/agent-runtime/synax/index.js";

/**
 * The read service has its own module graph and therefore its own in-memory
 * profile registry. Keep it aligned with the primary runtime before serving
 * session payloads; otherwise a GET can fail with NOT_FOUND for profileId
 * `synax` even though the session exists in SQLite.
 */
export function initializeReadServiceRuntime(): void {
  ensureGitMrProfileRegistered();
  ensureSynaxAgentRegistered();
  ensureLegacyGoalProfileRegistered();
}
