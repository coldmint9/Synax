import { agentRuntimeApi } from "../../adapters/transport/agentRuntime";
import { useNotificationStore } from "../../shared/state/notificationStore";
import type { FileLinkTarget } from "./fileLink";
import { openWorkspaceFile } from "./state/sessionWorkspaceStore";

/** Surface a rejected file link next to the surface that raised it. */
export function reportFileLinkFailure(message: string, detail?: string): void {
  useNotificationStore.getState().push({
    type: "error",
    message,
    ...(detail ? { detail } : {}),
  });
}

/**
 * Open a workspace file the reader pointed at, but only when it exists.
 *
 * Both the transcript and a previewed document ask first. A missing target is
 * reported as a notification instead of a viewer tab whose only content is a
 * read error, and no link ever navigates the window to a path the runtime
 * cannot serve.
 */
export async function openFileLinkTarget(
  sessionId: string,
  target: FileLinkTarget,
): Promise<void> {
  try {
    const entry = await agentRuntimeApi.sessionEnvironmentFileEntry(
      sessionId,
      target.path,
      target.rootId,
    );
    if (!entry.exists) {
      reportFileLinkFailure(`文件不存在：${target.path}`);
      return;
    }
    if (!entry.isFile) {
      reportFileLinkFailure(`无法预览文件夹：${target.path}`);
      return;
    }
  } catch (error) {
    reportFileLinkFailure(
      `无法打开：${target.path}`,
      error instanceof Error ? error.message : undefined,
    );
    return;
  }
  openWorkspaceFile(sessionId, target.path, target.line, target.rootId);
}
