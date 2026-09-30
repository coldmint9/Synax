import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProviderModelCapabilities } from './ProviderModelCapabilities';
import { createCustomDraft, draftToProviderDef, type ApiProviderDraft } from '../lib/providerPresets';
import { validateProviderDraft } from '../lib/validation';

describe('provider media model settings', () => {
  it('only offers declared input and output modalities', () => {
    const initial: ApiProviderDraft = {
      ...createCustomDraft([]),
      model: 'chat',
      models: ['chat'],
    };
    let draft = initial;
    function Settings() {
      const [value, setValue] = useState(initial);
      draft = value;
      return <ProviderModelCapabilities draft={value} onChange={(update) => setValue(update)} zh />;
    }
    render(<Settings />);
    expect(screen.queryAllByRole('checkbox', { name: '文件' })).toHaveLength(0);
    for (const label of ['文本', '图片', '音频', '视频']) {
      const checkboxes = screen.getAllByRole('checkbox', { name: label });
      expect(checkboxes).toHaveLength(2);
      fireEvent.click(checkboxes[0]);
      fireEvent.click(checkboxes[1]);
    }
    expect(draft.modelMeta.chat.inputModalities).toEqual(['text', 'image', 'audio', 'video']);
    expect(draft.modelMeta.chat.outputModalities).toEqual(['text', 'image', 'audio', 'video']);
  });

  it('keeps generation operations and parameters scoped to the edited model', () => {
    const initial: ApiProviderDraft = {
      ...createCustomDraft([]),
      id: 'custom-api:studio',
      apiKey: 'test-key',
      baseUrl: 'https://studio.example/api',
      mediaAdapter: 'openrouter',
      model: 'render',
      models: ['render', 'chat'],
    };
    let draft = initial;
    function Settings() {
      const [value, setValue] = useState(initial);
      draft = value;
      return <ProviderModelCapabilities draft={value} onChange={(update) => setValue(update)} zh />;
    }
    render(<Settings />);
    fireEvent.click(screen.getByRole('checkbox', { name: '生图' }));
    expect(draft.modelMeta.render.media?.operations).toEqual(['text-to-image']);
    fireEvent.click(screen.getByRole('checkbox', { name: '图生图' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '生视频' }));
    expect(draft.modelMeta.render.media?.operations).toEqual(['text-to-image', 'image-to-image', 'text-to-video']);
    fireEvent.change(screen.getByRole('textbox', { name: '参数名称' }), { target: { value: 'quality' } });
    fireEvent.click(screen.getByRole('button', { name: '添加参数' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'quality' }), { target: { value: 'low, high' } });
    expect(draft.modelMeta.render.media?.parameters?.quality.values).toEqual(['low', 'high']);
    expect(draft.modelMeta.chat).toBeUndefined();
    expect(validateProviderDraft(draft)).toEqual([]);
    expect(draftToProviderDef(draft).models.find((model) => model.id === 'render')?.media?.parameters?.quality.values).toEqual(['low', 'high']);
    fireEvent.click(screen.getByRole('checkbox', { name: '生图' }));
    expect(draft.modelMeta.render.media?.operations).toEqual(['text-to-video']);
  });
});
