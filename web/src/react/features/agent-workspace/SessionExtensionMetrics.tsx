import { ExtensionMetrics } from "../../components/extension-metrics/ExtensionMetrics";
import { useProviderMetrics } from "../../components/extension-metrics/useProviderMetrics";
import { useWorkspaceDisclosure } from "./useWorkspaceDisclosure";

export function SessionExtensionMetrics({
  sessionId,
  isLive,
  refreshKey,
}: {
  sessionId: string;
  isLive: boolean;
  refreshKey: string;
}) {
  const metrics = useProviderMetrics(
    { sessionId },
    { pollMs: isLive ? 5000 : 0, refreshKey },
  );
  // Workspace layout changes can remount the runtime panel while a run settles.
  // Keep the user's field picker open for this session through those remounts.
  const [selectionOpen, toggleSelection] = useWorkspaceDisclosure(
    `${sessionId}:extension-metrics`,
    false,
  );
  return (
    <ExtensionMetrics
      fields={metrics.fields}
      loading={metrics.loading}
      error={metrics.error}
      pending={metrics.pending}
      onUpdate={metrics.update}
      onRefresh={() => {
        void metrics.refresh();
      }}
      scope="session"
      selectionOpen={selectionOpen}
      onSelectionToggle={toggleSelection}
    />
  );
}
