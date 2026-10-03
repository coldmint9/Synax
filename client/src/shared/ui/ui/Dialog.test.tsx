import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button, CloseButton } from './Button';
import { AlertDialog, Dialog, DialogBody, DialogContainer, DialogDescription, DialogPanel, DialogTitle, Drawer } from './Dialog';

function Example({ busy = false }: { busy?: boolean }) {
  const [open, setOpen] = useState(false);
  return <><Button onClick={() => setOpen(true)}>Open editor</Button><Dialog open={open} onClose={() => setOpen(false)} dismissible={!busy}><DialogContainer><DialogPanel><DialogTitle>Edit item</DialogTitle><DialogDescription>Change its name</DialogDescription><DialogBody><input aria-label="Name" /></DialogBody><CloseButton>Cancel</CloseButton></DialogPanel></DialogContainer></Dialog></>;
}

describe('Headless dialogs', () => {
  it('labels the dialog, closes with Escape and restores trigger focus across reopening', async () => {
    const user = userEvent.setup();
    render(<Example />);
    const trigger = screen.getByRole('button', { name: 'Open editor' });
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Edit item' })).toHaveAccessibleDescription('Change its name');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('keeps dismissal protected during a pending operation', async () => {
    const user = userEvent.setup();
    render(<Example busy />);
    await user.click(screen.getByRole('button', { name: 'Open editor' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not mutate ordinary dialog behavior when alert dialogs or drawers are imported', async () => {
    const close = vi.fn();
    const view = render(<AlertDialog open onClose={close}><DialogContainer><DialogPanel><DialogTitle>Delete item</DialogTitle><Button>Keep item</Button></DialogPanel></DialogContainer></AlertDialog>);
    expect(screen.getByRole('alertdialog', { name: 'Delete item' })).toBeInTheDocument();
    view.unmount();
    render(<Drawer open onClose={close}><DialogContainer><DialogPanel><DialogTitle>Details</DialogTitle><Button>Done</Button></DialogPanel></DialogContainer></Drawer>);
    expect(screen.getByRole('dialog', { name: 'Details' })).toHaveAttribute('data-surface', 'drawer');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
