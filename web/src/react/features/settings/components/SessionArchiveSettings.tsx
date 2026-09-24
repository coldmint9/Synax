import { Button, Modal, Switch } from "@heroui/react";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocale } from "../../../../hooks/useLocale";
import {
  agentRuntimeApi,
  type SessionArchiveItem,
} from "../../../../lib/api/agentRuntime";
import type {
  GlobalConfig,
  UpdateGlobalConfigRequest,
} from "../../../../lib/contracts/config";
import { useNotificationStore } from "../../../state/notificationStore";
import { useShellStore } from "../../../state/shellStore";
import { FormRow } from "./FormRow";
import { SettingsCard } from "./SettingsCard";

const PAGE_SIZE = 20;

export function SessionArchiveSettings({
  config,
  onUpdate,
}: {
  config: GlobalConfig;
  onUpdate: (patch: UpdateGlobalConfigRequest) => Promise<void>;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const projects = useShellStore((state) => state.projects);
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const retention =
    config.sessionArchiveRetentionDays === undefined
      ? 7
      : config.sessionArchiveRetentionDays;
  const [days, setDays] = useState(retention ?? 7);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("");
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<SessionArchiveItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyBatchId, setBusyBatchId] = useState<string | null>(null);
  const [deleteItem, setDeleteItem] = useState<SessionArchiveItem | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await agentRuntimeApi.listSessionArchives({
        projectId: projectId || undefined,
        q: query || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setItems(result.items);
      setTotalCount(result.totalCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, projectId, offset]);

  useEffect(() => setDays(retention ?? 7), [retention]);

  const saveRetention = async (value: number | null) => {
    setSaving(true);
    try {
      await onUpdate({ sessionArchiveRetentionDays: value });
      await load();
    } catch (err) {
      useNotificationStore.getState().push({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const commitDays = () => {
    const value = Math.max(1, Math.min(3650, Math.trunc(days || 7)));
    setDays(value);
    if (value !== retention) void saveRetention(value);
  };

  const restore = async (item: SessionArchiveItem) => {
    setBusyBatchId(item.archiveBatchId);
    try {
      await agentRuntimeApi.restoreSessionArchive(item.archiveBatchId);
      useNotificationStore.getState().push({
        type: "success",
        message: zh ? "会话已恢复" : "Session restored",
      });
      await load();
    } catch (err) {
      useNotificationStore.getState().push({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyBatchId(null);
    }
  };

  const permanentlyDelete = async () => {
    if (!deleteItem) return;
    setBusyBatchId(deleteItem.archiveBatchId);
    try {
      await agentRuntimeApi.permanentlyDeleteSessionArchive(
        deleteItem.archiveBatchId,
      );
      setDeleteItem(null);
      useNotificationStore.getState().push({
        type: "success",
        message: zh ? "归档会话已彻底删除" : "Archived session permanently deleted",
      });
      await load();
    } catch (err) {
      useNotificationStore.getState().push({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyBatchId(null);
    }
  };

  const formatDate = (value: string) =>
    new Date(value).toLocaleString(zh ? "zh-CN" : "en-US");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">
          {zh ? "会话归档" : "Session Archive"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {zh
            ? "恢复归档会话，或彻底删除不再需要的历史。"
            : "Restore archived sessions or permanently remove history you no longer need."}
        </p>
      </div>

      <SettingsCard
        title={zh ? "自动清理" : "Automatic cleanup"}
        description={
          zh
            ? "归档达到保留期限后将被彻底删除。"
            : "Archives are permanently deleted after the retention period."
        }
        icon={Archive}
      >
        <div className="settings-rows">
          <FormRow
            label={zh ? "自动清理归档会话" : "Automatically clean up archives"}
            description={
              retention === null
                ? zh
                  ? "已关闭；归档会一直保留，直到手动彻底删除。"
                  : "Disabled; archives remain until manually deleted."
                : zh
                  ? "默认保留 7 天，可自定义。"
                  : "The default retention is 7 days and can be customized."
            }
          >
            <Switch
              size="sm"
              isSelected={retention !== null}
              isDisabled={saving}
              onChange={(selected) =>
                void saveRetention(selected ? days : null)
              }
              aria-label={
                zh ? "自动清理归档会话" : "Automatically clean up archives"
              }
            >
              <Switch.Content>
                <Switch.Control><Switch.Thumb /></Switch.Control>
              </Switch.Content>
            </Switch>
          </FormRow>
          {retention !== null && (
            <FormRow label={zh ? "保留天数" : "Retention days"}>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  className="settings-input w-24"
                  min={1}
                  max={3650}
                  value={days}
                  disabled={saving}
                  onChange={(event) => setDays(Number(event.target.value))}
                  onBlur={commitDays}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
                <span className="text-xs text-muted-foreground">
                  {zh ? "天" : "days"}
                </span>
              </div>
            </FormRow>
          )}
        </div>
      </SettingsCard>

      <SettingsCard title={zh ? "已归档会话" : "Archived sessions"}>
        <div className="flex flex-wrap gap-2 border-b border-border/40 p-3">
          <input
            className="settings-input min-w-56 flex-1"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOffset(0);
            }}
            placeholder={zh ? "搜索标题或提示…" : "Search title or prompt…"}
            aria-label={zh ? "搜索归档会话" : "Search archived sessions"}
          />
          <select
            className="settings-input min-w-40"
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setOffset(0);
            }}
            aria-label={zh ? "按项目筛选" : "Filter by project"}
          >
            <option value="">{zh ? "所有项目" : "All projects"}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </div>

        {error ? (
          <div className="p-4 text-sm text-danger" role="alert">{error}</div>
        ) : loading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {zh ? "正在加载…" : "Loading…"}
          </div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {zh ? "暂无归档会话" : "No archived sessions"}
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {items.map((item) => {
              const busy = busyBatchId === item.archiveBatchId;
              return (
                <div key={item.archiveBatchId} className="flex gap-4 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {item.title || item.prompt || item.rootSessionId}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>{projectNames.get(item.projectId) ?? item.projectId}</span>
                      <span>{zh ? "归档于" : "Archived"} {formatDate(item.archivedAt)}</span>
                      <span>{zh ? `${item.sessionCount} 个会话` : `${item.sessionCount} sessions`}</span>
                      <span>
                        {item.scheduledDeletionAt
                          ? `${zh ? "预计删除" : "Scheduled deletion"} ${formatDate(item.scheduledDeletionAt)}`
                          : zh
                            ? "自动清理已关闭"
                            : "Automatic cleanup disabled"}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      isPending={busy}
                      isDisabled={busyBatchId !== null}
                      onPress={() => void restore(item)}
                    >
                      <ArchiveRestore size={13} />
                      {zh ? "恢复" : "Restore"}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      isDisabled={busyBatchId !== null}
                      onPress={() => setDeleteItem(item)}
                    >
                      <Trash2 size={13} />
                      {zh ? "彻底删除" : "Delete permanently"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {totalCount > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-border/40 p-3">
            <span className="text-xs text-muted-foreground">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, totalCount)} / {totalCount}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                isDisabled={offset === 0}
                onPress={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                {zh ? "上一页" : "Previous"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                isDisabled={offset + PAGE_SIZE >= totalCount}
                onPress={() => setOffset(offset + PAGE_SIZE)}
              >
                {zh ? "下一页" : "Next"}
              </Button>
            </div>
          </div>
        )}
      </SettingsCard>

      <Modal.Backdrop
        isOpen={deleteItem !== null}
        onOpenChange={(open) => {
          if (!open && busyBatchId === null) setDeleteItem(null);
        }}
      >
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Icon><Trash2 className="text-danger" size={18} /></Modal.Icon>
              <Modal.Heading>{zh ? "彻底删除归档会话" : "Permanently delete archive"}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {deleteItem && (zh
                ? `彻底删除「${deleteItem.title || deleteItem.prompt}」及其归档批次中的 ${deleteItem.sessionCount} 个会话？相关消息、步骤、事件、历史和产物将永久删除，此操作不可撤销。`
                : `Permanently delete “${deleteItem.title || deleteItem.prompt}” and the ${deleteItem.sessionCount} sessions in its archive batch? Their messages, steps, events, history, and artifacts will be permanently removed. This cannot be undone.`)}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="ghost" size="sm" onPress={() => setDeleteItem(null)}>
                {zh ? "取消" : "Cancel"}
              </Button>
              <Button
                variant="danger"
                size="sm"
                isPending={busyBatchId === deleteItem?.archiveBatchId}
                onPress={() => void permanentlyDelete()}
              >
                {zh ? "彻底删除" : "Delete permanently"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  );
}
