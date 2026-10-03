import { useEffect, useMemo, useState } from 'react';
import { Check, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { apiRequest } from '../../adapters/transport/origin';
import type { MediaJob, MediaModel, MediaOperation } from '../../shared/contracts/media-generation';
import type { MediaDraft } from './useMediaDraft';
import type { GenerationMode } from './mediaSubmission';

export type MediaGenerationControlsProps = {
  mode: GenerationMode;
  selected: MediaModel | undefined;
  operation: MediaOperation | undefined;
  parameters: Record<string, string | number | boolean>;
  onParameters: (parameters: Record<string, string | number | boolean>) => void;
  job: MediaJob | undefined;
  error?: string | null;
  onCancel: () => void;
  onRetry?: () => void;
  media: MediaDraft | undefined;
};

export function MediaGenerationControls({
  mode, selected, operation, parameters, onParameters, job, error, onCancel, onRetry, media,
}: MediaGenerationControlsProps) {
  const fields = Object.entries(selected?.capabilities.parameters ?? {});
  const roles = selected?.capabilities.referenceRoles ?? ['reference'];
  const images = media?.parts.filter((part) => part.type === 'image') ?? [];
  const setParameter = (key: string, value: string | number | boolean) =>
    onParameters({ ...parameters, [key]: value });
  const active = job && !['succeeded', 'failed', 'cancelled', 'unknown'].includes(job.status);

  return (
    <div className="flex flex-wrap items-center gap-2" data-media-generation-controls={mode}>
      {!selected && (
        <span role="alert" className="text-[11px] text-danger">
          所选媒体模型不可用，请在供应商设置中配置。
        </span>
      )}
      {selected && !operation && (
        <span role="alert" className="text-[11px] text-danger">
          当前模型不支持所选参考素材对应的生成操作。
        </span>
      )}
      {operation && images.length > 0 && (
        <span className="text-[11px] text-muted-foreground">
          {mode === 'image' ? '图生图' : '图生视频'}
        </span>
      )}
      {images.length > 0 && roles.length > 1 && images.map((image, index) => (
        <label key={image.assetId} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          {`图片 ${index + 1}`}
          <select
            aria-label={`图片 ${index + 1} 参考角色`}
            value={String(parameters[`referenceRole:${image.assetId}`] ?? roles[0])}
            onChange={(event) => setParameter(`referenceRole:${image.assetId}`, event.target.value)}
            className="h-7 rounded border border-border bg-background px-1 text-foreground"
          >
            {roles.map((role) => (
              <option key={role} value={role}>
                {role === 'first_frame' ? '首帧' : role === 'last_frame' ? '尾帧' : '参考图'}
              </option>
            ))}
          </select>
        </label>
      ))}
      {fields.map(([key, schema]) => (
        <label key={key} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          {key}
          {schema.values?.length ? (
            <select
              aria-label={key}
              value={String(parameters[key] ?? schema.values[0])}
              onChange={(event) => {
                const value = schema.values?.find((option) => String(option) === event.target.value);
                if (value !== undefined) setParameter(key, value);
              }}
              className="h-7 max-w-32 rounded border border-border bg-background px-1 text-foreground"
            >
              {schema.values.map((value) => <option key={String(value)} value={String(value)}>{String(value)}</option>)}
            </select>
          ) : (
            <input
              aria-label={key}
              type={schema.min !== undefined || schema.max !== undefined ? 'number' : 'text'}
              min={schema.min}
              max={schema.max}
              value={String(parameters[key] ?? '')}
              onChange={(event) => {
                if (event.target.type === 'number') {
                  if (event.target.value !== '') setParameter(key, Number(event.target.value));
                } else setParameter(key, event.target.value);
              }}
              className="h-7 w-24 rounded border border-border bg-background px-1 text-foreground"
            />
          )}
        </label>
      ))}
      {active && (
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" role="status">
          <LoaderCircle size={12} className="animate-spin" />{job.status}
          <button type="button" onClick={onCancel} aria-label="取消媒体任务" title="取消媒体任务"><X size={14} /></button>
        </span>
      )}
      {job?.status === 'succeeded' && (
        <span role="status" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Check size={12} />已完成</span>
      )}
      {(error || (job && ['failed', 'cancelled', 'unknown'].includes(job.status))) && (
        <span role="alert" className="inline-flex items-center gap-1 text-[11px] text-danger">
          {error ?? job?.error ?? job?.status}
          {onRetry && <button type="button" onClick={onRetry} aria-label="重试媒体任务" title="重试媒体任务"><RotateCcw size={14} /></button>}
        </span>
      )}
    </div>
  );
}

export function useMediaGenerationModels(mode: 'chat' | GenerationMode) {
  const [models, setModels] = useState<MediaModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (mode === 'chat') return;
    const controller = new AbortController();
    void apiRequest<{ models: MediaModel[] }>('/api/agent-runtime/media/models', {
      signal: controller.signal, silent: true,
    }).then((result) => {
      setModels(result.models);
      setError(null);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => controller.abort();
  }, [mode]);
  const filtered = useMemo(() => models.filter((model) =>
    model.capabilities.operations.some((operation) => operation.endsWith(mode))), [models, mode]);
  return { models: filtered, error };
}
