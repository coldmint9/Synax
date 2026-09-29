import type {
  MediaJobInput,
  MediaModel,
  MediaOperation,
  MediaReferenceRole,
} from '../../../lib/contracts/media-generation';
import type { RuntimeContentPart } from '../../../lib/api/runtimeMedia';

export type GenerationMode = 'image' | 'video';

export function mediaOperationFor(
  model: MediaModel | undefined,
  mode: GenerationMode,
  hasImage: boolean,
): MediaOperation | undefined {
  const desired = `${hasImage ? 'image' : 'text'}-to-${mode}` as MediaOperation;
  return model?.capabilities.operations.includes(desired) ? desired : undefined;
}

export function mediaJobInput(
  model: MediaModel | undefined,
  mode: GenerationMode,
  prompt: string,
  parts: RuntimeContentPart[],
  parameters: Record<string, string | number | boolean>,
  idempotencyKey: string,
): MediaJobInput {
  if (!model) throw new Error('所选媒体模型不可用，请在供应商设置中检查模型配置。');
  const images = parts.filter((part) => part.type === 'image');
  if (images.length !== parts.length) throw new Error('当前媒体模型仅接受图片作为参考素材。');
  const operation = mediaOperationFor(model, mode, images.length > 0);
  if (!operation) throw new Error('所选模型不支持当前素材对应的生成操作。');
  if (!prompt.trim()) throw new Error('请输入生成提示词。');
  if (images.length > (model.capabilities.maxReferences ?? 16)) {
    throw new Error('参考图片数量超出模型限制。');
  }
  const roles = model.capabilities.referenceRoles ?? ['reference'];
  const references = images.map((image) => {
    const key = `referenceRole:${image.assetId}`;
    const role = (parameters[key] ?? roles[0]) as MediaReferenceRole;
    if (!roles.includes(role)) throw new Error('所选模型不支持该参考图片角色。');
    return { assetId: image.assetId, role };
  });
  for (const role of ['first_frame', 'last_frame'] as const) {
    if (references.filter((reference) => reference.role === role).length > 1) {
      throw new Error('首帧和尾帧各只能选择一张图片。');
    }
  }
  const configured = model.capabilities.parameters ?? {};
  const values: Record<string, string | number | boolean> = {};
  for (const [key, schema] of Object.entries(configured)) {
    const value = parameters[key] ?? schema.values?.[0];
    if (value === undefined) continue;
    if (schema.values && !schema.values.includes(value)) throw new Error(`${key} 不在模型支持的参数范围内。`);
    if (typeof value === 'number' && ((schema.min !== undefined && value < schema.min) || (schema.max !== undefined && value > schema.max))) {
      throw new Error(`${key} 不在模型支持的参数范围内。`);
    }
    values[key] = value;
  }
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    operation,
    prompt: prompt.trim(),
    references,
    parameters: values,
    idempotencyKey,
  };
}
