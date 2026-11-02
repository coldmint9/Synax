import { useMemo, useState } from "react";
import {
  SUPER_MAX_CONCURRENT,
  SUPER_MAX_MAX_NODES,
  SUPER_DEFAULT_MAX_NODES,
  SUPER_MIN_MAX_NODES,
  SUPER_MODEL_TAGS,
  SUPER_TASK_TYPES,
  SUPER_DEFAULT_CONFIG,
  type SuperCodingConfig,
  type SuperModelOption,
  type SuperModelTag,
  type SuperTaskType,
} from "../../../../../packages/contracts/super-coding";
import type { GlobalConfig } from "../../../shared/contracts/config";

interface Props {
  config: GlobalConfig;
  onUpdate: (patch: Record<string, unknown>) => Promise<void>;
}

const TASK_LABEL: Record<SuperTaskType, string> = {
  explore: "探索",
  design: "设计",
  implement: "实现",
  review: "审查",
  verify: "验证",
  docs: "文档",
};

const TAG_LABEL: Record<SuperModelTag, string> = {
  "deep-reasoning": "深度推理",
  "fast-edit": "快速改写",
  "long-context": "长上下文",
  "tool-use": "工具调用",
  cheap: "低成本",
  vision: "视觉",
};

function normalize(config: GlobalConfig): SuperCodingConfig {
  return { ...SUPER_DEFAULT_CONFIG, ...(config.superCoding ?? {}) };
}

/**
 * Model pool + ordered routes + node budget. Settings-only: the running graph
 * and its messages never live here.
 */
export function SuperModelPoolSection({ config, onUpdate }: Props) {
  const [draft, setDraft] = useState<SuperCodingConfig>(() => normalize(config));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const available = useMemo(
    () =>
      config.providers.flatMap((provider) =>
        provider.models.map((model) => ({
          id: `${provider.id}/${model.id}`,
          label: `${provider.label} · ${model.label}`,
        })),
      ),
    [config.providers],
  );

  const enabled = draft.models.filter((model) => model.enabled);
  // An empty pool is a supported state: children then inherit the session's
  // own model. A configured pool still needs at least one enabled entry,
  // because a disabled-only pool would route to models the user switched off.
  const canSave = !saving && (draft.models.length === 0 || enabled.length > 0);

  const patchDraft = (next: Partial<SuperCodingConfig>) => {
    setSaved(false);
    setError(null);
    setDraft((previous) => ({ ...previous, ...next }));
  };

  const updateModel = (id: string, update: Partial<SuperModelOption>) => {
    patchDraft({
      models: draft.models.map((model) =>
        model.id === id ? { ...model, ...update } : model,
      ),
    });
  };

  const addModel = (id: string) => {
    if (!id || draft.models.some((model) => model.id === id)) return;
    const option = available.find((item) => item.id === id);
    patchDraft({
      models: [
        ...draft.models,
        {
          id,
          label: option?.label ?? id,
          enabled: true,
          tags: ["tool-use"],
        },
      ],
    });
  };

  const toggleTag = (model: SuperModelOption, tag: SuperModelTag) => {
    const tags = model.tags.includes(tag)
      ? model.tags.filter((item) => item !== tag)
      : [...model.tags, tag];
    updateModel(model.id, { tags });
  };

  const save = async () => {
    if (draft.models.length > 0 && !enabled.length) {
      setError("至少启用一个模型，或移除全部模型以跟随主会话");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onUpdate({ superCoding: draft });
      setSaved(true);
    } catch (detail) {
      setError(detail instanceof Error ? detail.message : String(detail));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">子代理编排</h1>
        <p className="text-xs text-muted-foreground">
          池决定谁能上场，路由决定什么任务派谁；未配置时跟随主会话模型。
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">模型池</h2>
        {draft.models.length === 0 && (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
            未配置模型池：子代理跟随主会话模型。
          </p>
        )}
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {draft.models.map((model) => (
            <li key={model.id} className="flex flex-wrap items-start gap-3 p-3">
              <button
                type="button"
                role="switch"
                aria-checked={model.enabled}
                aria-label={`${model.enabled ? "停用" : "启用"} ${model.label}`}
                onClick={() => updateModel(model.id, { enabled: !model.enabled })}
                className={`mt-0.5 h-4 w-8 shrink-0 rounded-full ${model.enabled ? "bg-emerald-600" : "bg-border"}`}
              >
                <span
                  aria-hidden="true"
                  className={`block h-3 w-3 rounded-full bg-white transition-transform ${model.enabled ? "translate-x-4" : "translate-x-0.5"}`}
                />
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{model.label}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {model.id}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {SUPER_MODEL_TAGS.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      aria-pressed={model.tags.includes(tag)}
                      onClick={() => toggleTag(model, tag)}
                      className={`rounded border px-1.5 py-0.5 text-[10px] ${model.tags.includes(tag) ? "border-transparent bg-emerald-50 text-emerald-800" : "border-border text-muted-foreground"}`}
                    >
                      {TAG_LABEL[tag]}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  patchDraft({
                    models: draft.models.filter((item) => item.id !== model.id),
                  })
                }
                className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground"
              >
                移除
              </button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="super-model-add" className="text-xs text-muted-foreground">
            添加模型
          </label>
          <select
            id="super-model-add"
            defaultValue=""
            onChange={(event) => {
              addModel(event.target.value);
              event.target.value = "";
            }}
            className="rounded-md border border-border bg-card px-2 py-1 text-xs"
          >
            <option value="">选择已配置模型…</option>
            {available
              .filter((item) => !draft.models.some((model) => model.id === item.id))
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
          </select>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">路由</h2>
        <p className="text-xs text-muted-foreground">按任务类型指定；未指定时用默认模型。</p>
        {SUPER_TASK_TYPES.map((taskType) => {
          const route = draft.routes.find((item) => item.taskTypes.includes(taskType));
          return (
            <div key={taskType} className="flex items-center gap-2 text-xs">
              <label htmlFor={`super-route-${taskType}`} className="w-16 text-muted-foreground">
                {TASK_LABEL[taskType]}
              </label>
              <select
                id={`super-route-${taskType}`}
                value={route?.model ?? ""}
                onChange={(event) => {
                  const model = event.target.value;
                  const routes = draft.routes.filter(
                    (item) => !item.taskTypes.includes(taskType),
                  );
                  patchDraft({
                    routes: model
                      ? [...routes, { taskTypes: [taskType], model }]
                      : routes,
                  });
                }}
                className="rounded-md border border-border bg-card px-2 py-1"
              >
                <option value="">自动</option>
                {enabled.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
        <div className="flex items-center gap-2 text-xs">
          <label htmlFor="super-default-model" className="w-16 text-muted-foreground">
            默认
          </label>
          <select
            id="super-default-model"
            value={draft.defaultModel}
            onChange={(event) => patchDraft({ defaultModel: event.target.value })}
            className="rounded-md border border-border bg-card px-2 py-1"
          >
            <option value="">跟随主会话</option>
            {enabled.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">节点预算</h2>
        <div className="flex items-center gap-2 text-xs">
          <label htmlFor="super-max-nodes" className="w-16 text-muted-foreground">
            节点上限
          </label>
          <input
            id="super-max-nodes"
            type="number"
            min={SUPER_MIN_MAX_NODES}
            max={SUPER_MAX_MAX_NODES}
            value={draft.maxNodes}
            onChange={(event) =>
              patchDraft({
                maxNodes: Math.min(
                  SUPER_MAX_MAX_NODES,
                  Math.max(SUPER_MIN_MAX_NODES, Number(event.target.value) || SUPER_DEFAULT_MAX_NODES),
                ),
              })
            }
            className="w-16 rounded-md border border-border px-2 py-1"
          />
          <span className="text-muted-foreground">含 1 个终验槽</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label htmlFor="super-max-concurrent" className="w-16 text-muted-foreground">
            并发
          </label>
          <input
            id="super-max-concurrent"
            type="number"
            min={1}
            max={SUPER_MAX_CONCURRENT}
            value={draft.maxConcurrent}
            onChange={(event) =>
              patchDraft({
                maxConcurrent: Math.min(
                  SUPER_MAX_CONCURRENT,
                  Math.max(1, Number(event.target.value) || 1),
                ),
              })
            }
            className="w-16 rounded-md border border-border px-2 py-1"
          />
          <span className="text-muted-foreground">不高于运行时上限 {SUPER_MAX_CONCURRENT}</span>
        </div>
      </section>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!canSave}
          onClick={() => void save()}
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          {saving ? "保存中…" : "保存"}
        </button>
        {saved && (
          <span role="status" className="text-xs text-muted-foreground">
            已保存
          </span>
        )}
      </div>
    </div>
  );
}
