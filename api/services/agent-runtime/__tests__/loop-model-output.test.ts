import { describe, expect, it } from 'vitest';
import { parseLoopModelStepText } from '../loop-model-output.js';

describe('loop model output fallback parser', () => {
  it('accepts a leading JSON tool shorthand as the only text fallback protocol', () => {
    const step = parseLoopModelStepText('{"tool":"file.read","args":{"path":"package.json"}}Reading package.json.', false);

    expect(step.final).toBe(false);
    expect(step.finishReason).toBe('tool_text_fallback');
    expect(step.message).toBe('Reading package.json.');
    expect(step.toolCalls).toMatchObject([
      {
        toolId: 'file.read',
        args: { path: 'package.json' },
      },
    ]);
  });

  it('treats marker-style text as a final plain-text answer', () => {
    const step = parseLoopModelStepText('to=file.read {"path":"package.json"}', false);

    expect(step.final).toBe(true);
    expect(step.toolCalls).toEqual([]);
    expect(step.message).toBe('to=file.read {"path":"package.json"}');
  });
});
