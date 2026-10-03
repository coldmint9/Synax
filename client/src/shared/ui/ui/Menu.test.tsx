import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Menu, MenuAction, MenuButton, MenuItems } from './Menu';

describe('action menus', () => {
  it('opens by keyboard, skips disabled actions and restores focus after selection', async () => {
    const user = userEvent.setup(); const selected = vi.fn();
    render(<Menu><MenuButton>Actions</MenuButton><MenuItems><MenuAction disabled>Unavailable</MenuAction><MenuAction onClick={selected}>Export</MenuAction></MenuItems></Menu>);
    await user.tab(); await user.keyboard('{ArrowDown}');
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(menu).toHaveAttribute('aria-activedescendant', screen.getByRole('menuitem', { name: 'Export' }).id));
    await user.keyboard('{Enter}');
    expect(selected).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveFocus();
  });
  it('uses one trigger button, and Escape dismisses the portalled menu', async () => {
    const user = userEvent.setup();
    render(<Menu><MenuButton aria-label="Switch workspace">Synax</MenuButton><MenuItems><MenuAction>Workspace A</MenuAction></MenuItems></Menu>);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByRole('button'));
    expect(await screen.findByRole('menuitem')).toHaveTextContent('Workspace A');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
