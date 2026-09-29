import { describe, expect, it } from 'vitest';
import type { MediaModel } from '../../../lib/contracts/media-generation';
import type { RuntimeContentPart } from '../../../lib/api/runtimeMedia';
import { mediaJobInput, mediaOperationFor } from './mediaSubmission';

const imageId = `asset_${'a'.repeat(32)}`;
const secondId = `asset_${'b'.repeat(32)}`;
const image = (assetId: string): RuntimeContentPart => ({ type: 'image', assetId });

const imageModel: MediaModel = {
  providerId: 'custom-api:studio', modelId: 'image-model', label: 'Image',
  providerLabel: 'Studio', adapter: 'openrouter',
  capabilities: {
    operations: ['text-to-image', 'image-to-image'],
    referenceRoles: ['reference'], maxReferences: 1,
    parameters: { quality: { values: ['low', 'high'] } },
  },
};

const videoModel: MediaModel = {
  ...imageModel,
  modelId: 'video-model',
  capabilities: {
    operations: ['text-to-video', 'image-to-video'],
    referenceRoles: ['reference', 'first_frame', 'last_frame'],
    parameters: { duration: { values: [4, 8] } },
  },
};

describe('media submission', () => {
  it('uses the exact selected model and only its declared parameters', () => {
    expect(mediaJobInput(imageModel, 'image', '  city  ', [image(imageId)], {
      quality: 'high', duration: 8, [`referenceRole:${imageId}`]: 'reference',
    }, 'key')).toEqual({
      providerId: 'custom-api:studio', modelId: 'image-model',
      prompt: 'city', operation: 'image-to-image',
      references: [{ assetId: imageId, role: 'reference' }],
      parameters: { quality: 'high' }, idempotencyKey: 'key',
    });
  });

  it('selects video roles independently for first and last frames', () => {
    const result = mediaJobInput(videoModel, 'video', 'pan', [image(imageId), image(secondId)], {
      [`referenceRole:${imageId}`]: 'first_frame',
      [`referenceRole:${secondId}`]: 'last_frame', duration: 8,
    }, 'video-key');
    expect(result.operation).toBe('image-to-video');
    expect(result.references).toEqual([
      { assetId: imageId, role: 'first_frame' },
      { assetId: secondId, role: 'last_frame' },
    ]);
    expect(result.parameters).toEqual({ duration: 8 });
  });

  it('rejects an unavailable model or an unsupported operation instead of falling back to chat', () => {
    expect(() => mediaJobInput(undefined, 'image', 'city', [], {}, 'key')).toThrow(/不可用/);
    expect(mediaOperationFor(videoModel, 'image', false)).toBeUndefined();
    expect(() => mediaJobInput(videoModel, 'image', 'city', [], {}, 'key')).toThrow(/不支持/);
    expect(() => mediaJobInput(imageModel, 'image', 'city', [image(imageId), image(secondId)], {}, 'key')).toThrow(/数量/);
    expect(() => mediaJobInput(videoModel, 'video', 'pan', [image(imageId), image(secondId)], {
      [`referenceRole:${imageId}`]: 'first_frame',
      [`referenceRole:${secondId}`]: 'first_frame',
    }, 'key')).toThrow(/首帧/);
  });
});
