import { Check, Circle, ListTodo, LoaderCircle } from "lucide-react";
import type { TodoItem } from "../../../lib/api/agentRuntime";
import { useLocale } from "../../../hooks/useLocale";
import { WorkspaceSection } from "./WorkspaceSection";

export function SessionTodoPanel({ items }: { items: TodoItem[] }) {
  const { locale } = useLocale();
  if (!items.length) return null;
  const done = items.filter((item) => item.status === "done").length;
  const zh = locale === "zh";
  return (
    <WorkspaceSection
      icon={<ListTodo size={13} />}
      title={zh ? "任务进度" : "Progress"}
      summary={`${done} / ${items.length}`}
    >
      <ol className="work-todos">
        {items.map((item) => (
          <li key={item.id} data-status={item.status}>
            {item.status === "done" ? (
              <Check size={12} aria-label={zh ? "已完成" : "Completed"} />
            ) : item.status === "in_progress" ? (
              <LoaderCircle
                size={12}
                className="animate-spin"
                aria-label={zh ? "进行中" : "In progress"}
              />
            ) : (
              <Circle size={12} aria-label={zh ? "待处理" : "Pending"} />
            )}
            <span>{item.label}</span>
          </li>
        ))}
      </ol>
    </WorkspaceSection>
  );
}
