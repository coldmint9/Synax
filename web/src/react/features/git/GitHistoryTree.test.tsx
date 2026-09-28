import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { GitWorkspaceSummary } from '../../../lib/api/project';
import GitHistoryTree from './GitHistoryTree';

const workspace: GitWorkspaceSummary = {
  repositoryRoot: '/fixture/repo', defaultPath: '/fixture/repo', branches: [], worktrees: [],
  commits: [
    { id: 'merge1', parents: ['left', 'right'], subject: 'Merge UI', author: 'Alex', authoredAt: '2026-09-26T00:00:00Z', refs: ['main'], rebase: false },
    { id: 'left', parents: [], subject: 'Improve inputs', author: 'Casey', authoredAt: '2026-09-25T00:00:00Z', refs: [], rebase: false },
  ],
};

describe('Git history table', () => {
  it('renders a semantic table with five labelled columns and opens commit details by keyboard', async () => {
    const user = userEvent.setup();
    const { container } = render(<GitHistoryTree workspace={workspace} />);
    const table = screen.getByRole('table', { name: 'Git 提交历史' });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(5);
    expect(within(table).getByRole('columnheader', { name: '状态' })).toBeInTheDocument();
    const select = within(table).getByRole('button', { name: 'Improve inputs' });
    select.focus(); await user.keyboard('{Enter}');
    expect(screen.getByRole('complementary')).toHaveTextContent('Improve inputs');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(container.querySelector('.history-tree-rail')).toHaveAttribute('height', '136');
  });

  it('preserves merge filtering and search without a component-library table', async () => {
    const user = userEvent.setup();
    const { container } = render(<GitHistoryTree workspace={workspace} />);
    await user.click(screen.getByRole('button', { name: '合并提交' }));
    expect(screen.getByRole('button', { name: '合并提交' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Improve inputs' })).not.toBeInTheDocument();
    expect(container.querySelector('.history-tree-rail')).toHaveAttribute('height', '68');
    await user.click(screen.getByRole('button', { name: '全部' }));
    await user.type(screen.getByRole('textbox', { name: '搜索提交、分支或作者' }), 'Casey');
    expect(screen.getByRole('button', { name: 'Improve inputs' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Merge UI' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: '搜索提交、分支或作者' }), ' no match');
    expect(container.querySelector('.history-tree-rail')).toBeNull();
  });
});
