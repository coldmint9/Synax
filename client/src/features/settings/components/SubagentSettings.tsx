import { InfoTooltip } from "@/shared/ui/ui/InfoTooltip";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/shared/ui/ui/Button";
import { Dialog, DialogContainer, DialogPanel, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/shared/ui/ui/Dialog";
import { Description, Field, FieldError, Input, Label, TextArea } from "@/shared/ui/ui/Field";
import { Select } from "@/shared/ui/ui/Select";
import { Switch } from "@/shared/ui/ui/Toggle";
import { subagentsApi, type CustomSubagent, type CustomSubagentInput } from "../../../adapters/transport/subagents";
import { useLocale } from "../../../shared/hooks/useLocale";
import type { GlobalConfig, ProviderDef } from "../../../shared/contracts/config";
import { buildAgentModelOptions } from "../../agent-workspace/composer/modelSelection";
import { modelOptionLabel } from "../lib/providerPresets";

export function SubagentSettings({ globalConfig = null, providers = [] }: {
  globalConfig?: GlobalConfig | null;
  providers?: ProviderDef[];
}) {
  const zh = useLocale().locale === "zh";
  const [items, setItems] = useState<CustomSubagent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<CustomSubagent | "new" | null>(null);
  const [removing, setRemoving] = useState<CustomSubagent | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setItems((await subagentsApi.list()).items); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async (input: CustomSubagentInput) => {
    const { item } = editor === "new" ? await subagentsApi.create(input) : await subagentsApi.update(editor!.id, input);
    setItems(current => [...current.filter(value => value.id !== item.id), item].sort((a, b) => a.name.localeCompare(b.name)));
    setEditor(null); setNotice(zh ? "子代理已保存，可在输入框中选择。" : "Subagent saved. Select it in the composer.");
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true); setError("");
    try {
      await subagentsApi.remove(removing.id);
      setItems(current => current.filter(item => item.id !== removing.id));
      setRemoving(null); setNotice(zh ? "子代理已删除。" : "Subagent deleted.");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  return <div className="space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-center gap-1"><h1 className="text-lg font-semibold">{zh ? "子代理" : "Subagents"}</h1>
        <InfoTooltip label={zh ? "子代理说明" : "About subagents"}>{zh ? "在输入框中选择角色后由主代理委派；未选择时自动配置，并继承会话授权。" : "Select a role in the composer to delegate. Otherwise agents are configured automatically with session permissions."}</InfoTooltip></div>
      <Button variant="primary" onClick={() => { setError(""); setEditor("new"); }}><Plus size={15} aria-hidden="true" />{zh ? "新建子代理" : "New subagent"}</Button>
    </header>
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {error && <div role="alert" className="flex items-center gap-3 text-sm text-destructive">{error}<Button size="sm" onClick={() => void load()}>{zh ? "重试" : "Retry"}</Button></div>}
    {loading ? <p role="status" className="py-8 text-sm text-muted-foreground">{zh ? "正在加载…" : "Loading…"}</p> : !items.length ?
      <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center"><Bot size={28} className="mx-auto mb-3 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-medium">{zh ? "还没有自定义子代理" : "No custom subagents yet"}</h2>
</div> :
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">{items.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex min-w-0 flex-1 items-start gap-3"><Bot size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="min-w-0">
          <h2 className="break-words text-sm font-medium">{item.name}{!item.enabled && <span className="ml-2 text-xs text-muted-foreground">{zh ? "已停用" : "Disabled"}</span>}</h2>
          <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{item.description}</p>
          <p className="mt-2 text-xs text-muted-foreground">{item.access === "read-only" ? (zh ? "只读" : "Read-only") : (zh ? "继承会话授权" : "Inherit session permissions")}{item.model && ` · ${item.model}`}</p>
        </div></div>
        <div className="flex shrink-0 gap-1"><Button variant="ghost" iconOnly aria-label={`${zh ? "编辑" : "Edit"} ${item.name}`} onClick={() => setEditor(item)}><Pencil size={15} /></Button>
          <Button variant="ghost" iconOnly aria-label={`${zh ? "删除" : "Delete"} ${item.name}`} onClick={() => { setError(""); setRemoving(item); }}><Trash2 size={15} /></Button></div>
      </li>)}</ul>}
    {editor && <SubagentEditor key={editor === "new" ? "new" : editor.id} value={editor === "new" ? undefined : editor} globalConfig={globalConfig} providers={providers} onSave={save} onClose={() => setEditor(null)} />}
    <Dialog open={Boolean(removing)} onClose={() => { if (!busy) setRemoving(null); }}><DialogContainer size="sm"><DialogPanel>
      <DialogHeader><DialogTitle>{zh ? "删除子代理？" : "Delete subagent?"}</DialogTitle></DialogHeader>
      <DialogBody><p className="text-sm text-muted-foreground">{zh ? `删除“${removing?.name ?? ""}”后，它将不再出现在输入框选项中。已启动的任务保留原配置。` : `“${removing?.name ?? ""}” will no longer be available in the composer. Running tasks keep their saved configuration.`}</p>{error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}</DialogBody>
      <DialogFooter><Button disabled={busy} onClick={() => setRemoving(null)}>{zh ? "取消" : "Cancel"}</Button><Button variant="danger" pending={busy} onClick={() => void remove()}>{zh ? "删除" : "Delete"}</Button></DialogFooter>
    </DialogPanel></DialogContainer></Dialog>
  </div>;
}

function SubagentEditor({ value, globalConfig, providers, onSave, onClose }: {
  value?: CustomSubagent;
  globalConfig: GlobalConfig | null;
  providers: ProviderDef[];
  onSave: (input: CustomSubagentInput) => Promise<void>;
  onClose: () => void;
}) {
  const zh = useLocale().locale === "zh";
  const [form, setForm] = useState<CustomSubagentInput>(() => ({ name: value?.name ?? "", description: value?.description ?? "", instructions: value?.instructions ?? "",
    access: value?.access ?? "inherit", enabled: value?.enabled ?? true, model: value?.model, thinkingMode: value?.thinkingMode }));
  const [capabilities, setCapabilities] = useState(value?.capabilities?.join("\n") ?? "");
  const [writeScope, setWriteScope] = useState(value?.writeScope?.join("\n") ?? "");
  const [skillIds, setSkillIds] = useState(value?.skillIds?.join("\n") ?? "");
  const [mcpIds, setMcpIds] = useState(value?.mcpServerIds?.join("\n") ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  // Exactly the models a session can start on: `profile.model` can never name
  // a ref the runtime would reject later.
  const modelOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const model of buildAgentModelOptions(globalConfig, providers).apiModels) {
      const ref = `${model.providerId}/${model.modelId}`;
      if (!seen.has(ref)) seen.set(ref, modelOptionLabel(providers, model.providerId, model.label));
    }
    if (form.model && !seen.has(form.model)) seen.set(form.model, `${form.model} (${zh ? "不可用" : "unavailable"})`);
    return [...seen].map(([ref, label]) => ({ value: ref, label }));
  }, [form.model, globalConfig, providers, zh]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const lines = (text: string) => text.trim() ? [...new Set(text.split(/[\n,]/).map(item => item.trim()).filter(Boolean))] : undefined;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setAttempted(true); setError("");
    if (!form.name.trim() || !form.description.trim() || !form.instructions.trim()) { setError(zh ? "请填写名称、用途和指令。" : "Provide a name, purpose and instructions."); return; }
    setSaving(true);
    try { await onSave({ ...form, model: form.model?.trim() || undefined, capabilities: lines(capabilities), writeScope: lines(writeScope), skillIds: lines(skillIds), mcpServerIds: lines(mcpIds) }); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };
  return <Dialog open onClose={() => { if (!saving) onClose(); }}><DialogContainer size="lg"><DialogPanel>
    <form onSubmit={event => void submit(event)} noValidate className="flex min-h-0 flex-col gap-5">
      <DialogHeader><DialogTitle>{value ? (zh ? "编辑子代理" : "Edit subagent") : (zh ? "新建子代理" : "New subagent")}</DialogTitle></DialogHeader>
      <DialogBody className="max-h-[65dvh] space-y-4 overflow-y-auto">
        {error && <p ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-destructive">{error}</p>}
        {([['name', zh ? '名称' : 'Name', 80], ['description', zh ? '用途' : 'Purpose', 500]] as const).map(([key, label, max]) =>
          <Field key={key} invalid={attempted && !form[key].trim()}><Label>{label}</Label><Input autoFocus={key === "name"} maxLength={max} value={form[key]} disabled={saving} onChange={event => setForm(current => ({ ...current, [key]: event.target.value }))} />
            {attempted && !form[key].trim() && <FieldError>{zh ? "此项必填" : "Required"}</FieldError>}</Field>)}
        <Field invalid={attempted && !form.instructions.trim()}><Label>{zh ? "工作指令" : "Instructions"}</Label><TextArea rows={5} maxLength={16_000} disabled={saving} value={form.instructions} onChange={event => setForm(current => ({ ...current, instructions: event.target.value }))} placeholder={zh ? "描述职责、处理方式和交付要求…" : "Describe the role, approach and deliverables…"} />
          {attempted && !form.instructions.trim() && <FieldError>{zh ? "此项必填" : "Required"}</FieldError>}</Field>
        <Select label={zh ? "权限范围" : "Access"} value={form.access ?? "inherit"} disabled={saving} onChange={value => setForm(current => ({ ...current, access: value ?? "inherit" }))}
          options={[{ value: "inherit", label: zh ? "继承当前会话授权" : "Inherit session permissions" }, { value: "read-only", label: zh ? "只读分析" : "Read-only analysis" }]} />
        <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-xs font-medium">{zh ? "高级配置（可选）" : "Advanced configuration (optional)"}</summary><div className="mt-4 space-y-4">
          {modelOptions.length > 0 && <Select label={zh ? "模型" : "Model"} value={form.model ?? ""} disabled={saving}
            onChange={model => setForm(current => ({ ...current, model: model || undefined }))}
            options={[{ value: "", label: zh ? "继承主代理模型" : "Inherit the primary agent’s model" }, ...modelOptions]} />}
          <Select label={zh ? "思考模式" : "Thinking mode"} value={form.thinkingMode ?? "inherit"} disabled={saving} onChange={value => setForm(current => ({ ...current, thinkingMode: value === "inherit" || !value ? undefined : value }))}
            options={[{ value: "inherit", label: zh ? "继承主代理" : "Inherit" }, { value: "fast", label: zh ? "快速" : "Fast" }, { value: "standard", label: zh ? "标准" : "Standard" }, { value: "deep", label: zh ? "深入" : "Deep" }]} />
          {([{ label: zh ? "工具 ID" : "Tool IDs", value: capabilities, set: setCapabilities, hint: zh ? "每行一个；留空由主代理自动分配。" : "One per line; leave empty for automatic configuration." },
            { label: zh ? "写入范围" : "Write scope", value: writeScope, set: setWriteScope, hint: zh ? "项目内的相对文件或目录，每行一个。设置后仅使用文件工具写入。" : "Workspace-relative files or directories, one per line. Scoped writes use native file tools." },
            { label: zh ? "技能 ID" : "Skill IDs", value: skillIds, set: setSkillIds, hint: zh ? "每行一个；留空继承主代理已配置的技能。" : "One per line; leave empty to inherit assigned skills." },
            { label: zh ? "MCP 服务器 ID" : "MCP server IDs", value: mcpIds, set: setMcpIds, hint: zh ? "每行一个；留空继承主代理已连接的服务。" : "One per line; leave empty to inherit connected services." }]).map(field =>
              <Field key={field.label}><Label>{field.label}</Label><TextArea rows={2} value={field.value} disabled={saving} onChange={event => field.set(event.target.value)} /><Description>{field.hint}</Description></Field>)}
        </div></details>
        <Field className="grid-cols-[1fr_auto] items-center"><Label>{zh ? "在输入框中可选" : "Available in the composer"}</Label><Switch disabled={saving} checked={form.enabled ?? true} onChange={enabled => setForm(current => ({ ...current, enabled }))} /></Field>
      </DialogBody>
      <DialogFooter><Button disabled={saving} onClick={onClose}>{zh ? "取消" : "Cancel"}</Button><Button type="submit" variant="primary" pending={saving}>{zh ? "保存" : "Save"}</Button></DialogFooter>
    </form>
  </DialogPanel></DialogContainer></Dialog>;
}
