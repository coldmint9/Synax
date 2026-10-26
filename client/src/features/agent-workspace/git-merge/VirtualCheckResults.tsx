import { useState } from "react";
import type { MergeCheckConfig } from "../../../adapters/transport/gitMr";
import type { taskPresentation } from "./model";
import { VirtualList } from "./VirtualList";

type Result = ReturnType<typeof taskPresentation>["results"][number];
const label = ({ result, current }: Result) =>
  !result
    ? "待运行"
    : !current
      ? "已过期"
      : result.status === "passed"
        ? "通过"
        : "失败";
export function VirtualCheckResults({ results }: { results: Result[] }) {
  const [selected, setSelected] = useState<MergeCheckConfig["id"] | null>(null);
  const detail = results.find((item) => item.check.id === selected);
  return (
    <>
      <VirtualList
        items={results}
        label="验证检查列表"
        rowHeight={36}
        maxHeight={180}
        getKey={(item) => item.check.id}
        renderRow={(item) => (
          <button
            className="conversation-git-check-row"
            aria-expanded={selected === item.check.id}
            onClick={() =>
              setSelected(selected === item.check.id ? null : item.check.id)
            }
          >
            <strong>{item.check.id}</strong>
            <span>{label(item)}</span>
          </button>
        )}
      />
      {detail && (
        <div className="conversation-git-check-detail">
          <p className="conversation-git-check-command">
            <code>
              {detail.check.executable} {detail.check.args.join(" ")}
            </code>
            <span>{detail.check.timeoutMs.toLocaleString()} ms timeout</span>
          </p>
          {detail.result && <pre>{detail.result.output || "（无输出）"}</pre>}
        </div>
      )}
    </>
  );
}
