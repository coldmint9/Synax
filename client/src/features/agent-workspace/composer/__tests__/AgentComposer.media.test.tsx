import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState, type ComponentProps } from 'react';
import type { MediaModel, MediaJob } from '../../../../shared/contracts/media-generation';
import type { MediaDraft } from '../../../media/useMediaDraft';
import { AgentComposer } from '../AgentComposer';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../../../adapters/transport/origin', () => ({ apiRequest: mocks.request }));
vi.mock('@/features/media/useInputCapability', () => ({
  useInputCapability: () => ({ blocked: false, error: false, loading: false }),
}));

const imageModel: MediaModel = {
  providerId: 'custom-api:studio', modelId: 'image-model', label: 'Image',
  providerLabel: 'Studio', adapter: 'openrouter',
  capabilities: { operations: ['text-to-image', 'image-to-image'], referenceRoles: ['reference'], parameters: { quality: { values: ['low', 'high'] } } },
};
const videoModel: MediaModel = {
  ...imageModel, modelId: 'video-model', label: 'Video',
  capabilities: { operations: ['text-to-video', 'image-to-video'], referenceRoles: ['first_frame', 'last_frame', 'reference'], parameters: { duration: { values: [4, 8] } } },
};

const noop = () => {};
const base: ComponentProps<typeof AgentComposer> = {
  projectId: 'p1', sessionId: 's1', content: 'Generate a city',
  onContentChange: noop, onSubmit: noop, providerId: imageModel.providerId,
  modelId: imageModel.modelId, capability: 'image_generation', onModelSelect: noop,
  providers: [], globalConfig: null, documentId: null, onDocumentChange: noop,
  wikiAttachMode: 'auto', onWikiAttachModeChange: noop, documents: [],
  skillIds: [], onSkillIdsChange: noop, reasoningEffort: 'high',
  onReasoningEffortChange: noop, permissionTier: 'boundary',
  onPermissionTierChange: noop, modeControl: <span>Mode</span>,
  modelControl: <span>Model</span>,
};

const inputMedia = (parts: Array<{ type: 'image'; assetId: string }> = []) => ({
  parts, ready: true, clear: vi.fn(), items: [],
}) as unknown as MediaDraft;

beforeEach(() => {
  localStorage.clear();
  mocks.request.mockReset();
  mocks.request.mockImplementation(async (url: string, options?: { method?: string; body?: string }) => {
    if (url.endsWith('/media/models')) return { models: [imageModel, videoModel] };
    if (url.endsWith('/media-jobs') && !options?.method) return { jobs: [] };
    if (url.endsWith('/media-jobs') && options?.method === 'POST') {
      const input = JSON.parse(options.body ?? '{}');
      return { job: { id: 'job-new', sessionId: 's1', input, status: 'running', resultAssetIds: [], cancellationSupported: true } };
    }
    throw new Error(`Unexpected request ${url}`);
  });
});

describe('capability-driven media composer', () => {
  it('creates an image session and media job without sending a chat message', async () => {
    const onSubmit = vi.fn();
    const onCreateMediaSession = vi.fn(async () => 's1');
    const onMediaSubmitted = vi.fn();
    render(<AgentComposer {...base} sessionId={undefined} onSubmit={onSubmit}
      onCreateMediaSession={onCreateMediaSession} onMediaSubmitted={onMediaSubmitted} media={inputMedia()} />);
    const send = screen.getByRole('button', { name: /发送|Send/ });
    await waitFor(() => expect(send).not.toBeDisabled());
    fireEvent.click(send);
    await waitFor(() => expect(onMediaSubmitted).toHaveBeenCalledWith('s1'));
    expect(onCreateMediaSession).toHaveBeenCalledWith('Generate a city');
    expect(onSubmit).not.toHaveBeenCalled();
    const request = mocks.request.mock.calls.find(([url, options]) => String(url).endsWith('/media-jobs') && options?.method === 'POST');
    expect(JSON.parse(request?.[1].body ?? '{}')).toMatchObject({
      providerId: 'custom-api:studio', modelId: 'image-model', operation: 'text-to-image', prompt: 'Generate a city',
    });
  });

  it('never borrows another media model when the selected model is unavailable', async () => {
    const onSubmit = vi.fn();
    render(<AgentComposer {...base} modelId="missing-image-model" onSubmit={onSubmit} media={inputMedia()} />);
    await screen.findByText(/所选媒体模型不可用/);
    const send = screen.getByRole('button', { name: /发送|Send/ });
    expect(send).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.filter(([url, options]) => String(url).endsWith('/media-jobs') && options?.method === 'POST')).toHaveLength(0);
  });

  it('restores a video job, cancels it, and retries with the same model and retained input', async () => {
    const ref = `asset_${'a'.repeat(32)}`;
    const oldJob: MediaJob = {
      id: 'job-old', sessionId: 's1',
      input: { providerId: videoModel.providerId, modelId: videoModel.modelId, operation: 'image-to-video',
        prompt: 'Generate a city', references: [{ assetId: ref, role: 'first_frame' }], idempotencyKey: 'old' },
      status: 'running', resultAssetIds: [], cancellationSupported: true,
      createdAt: '', updatedAt: '',
    };
    mocks.request.mockImplementation(async (url: string, options?: { method?: string; body?: string }) => {
      if (url.endsWith('/media/models')) return { models: [imageModel, videoModel] };
      if (url.endsWith('/media-jobs') && !options?.method) return { jobs: [oldJob] };
      if (url.endsWith('/job-old/cancel')) return { job: { ...oldJob, status: 'cancelled' } };
      if (url.endsWith('/media-jobs') && options?.method === 'POST') return {
        job: { ...oldJob, id: 'job-retry', status: 'running', input: JSON.parse(options.body ?? '{}') },
      };
      throw new Error(`Unexpected request ${url}`);
    });
    function ControlledVideo() {
      const [content, setContent] = useState('Generate a city');
      const [parts, setParts] = useState([{ type: 'image' as const, assetId: ref }]);
      const media = { ...inputMedia(parts), clear: () => setParts([]) };
      return <AgentComposer {...base} modelId={videoModel.modelId} capability="video_generation" content={content} onContentChange={setContent} media={media} />;
    }
    render(<ControlledVideo />);
    await screen.findByRole('button', { name: '取消媒体任务' });
    fireEvent.click(screen.getByRole('button', { name: '取消媒体任务' }));
    await screen.findByRole('button', { name: '重试媒体任务' });
    fireEvent.click(screen.getByRole('button', { name: '重试媒体任务' }));
    await waitFor(() => expect(mocks.request.mock.calls.some(([url, options]) => String(url).endsWith('/media-jobs') && options?.method === 'POST')).toBe(true));
    const post = mocks.request.mock.calls.find(([url, options]) => String(url).endsWith('/media-jobs') && options?.method === 'POST');
    expect(JSON.parse(post?.[1].body ?? '{}')).toMatchObject({ providerId: videoModel.providerId, modelId: videoModel.modelId, operation: 'image-to-video', prompt: 'Generate a city' });
    expect(screen.getByRole('textbox')).toHaveValue('Generate a city');
  });
});
