import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WikiMarkdown } from '../WikiMarkdown';
const renderMarkdown = vi.hoisted(() => vi.fn());
vi.mock('../../../components/markdown/MarkdownRenderer', () => ({
  sharedMarkdownComponents: {},
  MarkdownRenderer: ({ content }: { content: string }) => { renderMarkdown(content); return <div>{content}</div>; },
}));
beforeEach(() => renderMarkdown.mockClear());
describe('Wiki markdown render isolation', () => {
  it('does not reparse unchanged content when a parent switches Wiki views', () => {
    const { rerender } = render(<WikiMarkdown content="# Same document" />);
    rerender(<WikiMarkdown content="# Same document" />);
    expect(renderMarkdown).toHaveBeenCalledTimes(1);
    rerender(<WikiMarkdown content="# Updated document" />);
    expect(renderMarkdown).toHaveBeenCalledTimes(2);
    expect(renderMarkdown).toHaveBeenLastCalledWith('# Updated document');
  });
});
