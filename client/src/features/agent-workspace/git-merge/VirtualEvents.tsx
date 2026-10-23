import { useState } from "react";
import { VirtualList } from "./VirtualList";
export function VirtualEvents({
  events,
}: {
  events: { at: string; message: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <details
      className="conversation-git-events"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>操作记录 · {events.length} 条</summary>
      {open && (
        <VirtualList
          items={events}
          label="操作记录列表"
          rowHeight={44}
          maxHeight={220}
          getKey={(event, index) => `${event.at}:${index}`}
          renderRow={(event) => (
            <button
              className="conversation-git-event-row"
              onClick={() =>
                setSelected(selected === event.message ? null : event.message)
              }
              title={event.message}
            >
              <time>{new Date(event.at).toLocaleString()}</time>
              <span>{event.message}</span>
            </button>
          )}
        />
      )}
      {open && selected && (
        <p className="conversation-git-event-detail">{selected}</p>
      )}
    </details>
  );
}
