import { Menu as HeadlessMenu, MenuButton as HeadlessButton, MenuItem as HeadlessItem, MenuItems as HeadlessItems, type MenuButtonProps, type MenuItemsProps, type MenuProps } from '@headlessui/react';
import clsx from 'clsx';
import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes } from 'react';

export function Menu({ className, ...props }: Omit<MenuProps<'div'>, 'as' | 'className'> & { className?: string }) {
  return <HeadlessMenu {...props} as="div" className={clsx('ui-menu relative inline-flex min-w-0', className)} />;
}
export const MenuButton = forwardRef<HTMLButtonElement, Omit<MenuButtonProps<'button'>, 'as' | 'className'> & { className?: string }>(function MenuButton({ className, ...props }, ref) {
  return <HeadlessButton {...props} ref={ref} className={clsx('ui-menu-trigger inline-flex min-w-0 items-center justify-center gap-1.5 rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40', className)} />;
});
export const MenuItems = forwardRef<HTMLDivElement, Omit<MenuItemsProps<'div'>, 'as' | 'className'> & { className?: string }>(function MenuItems({ className, anchor = { to: 'bottom end', gap: 8, padding: 8 }, ...props }, ref) {
  return <HeadlessItems {...props} ref={ref} anchor={anchor} portal className={clsx('ui-menu-items z-[1200] min-w-44 max-w-[calc(100vw-16px)] rounded-xl border border-border bg-card p-1.5 text-xs text-card-foreground shadow-lg outline-none', className)} />;
});
export function MenuAction({ className, danger = false, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return <HeadlessItem {...props} as="button" type="button" disabled={disabled} className={clsx('ui-menu-action flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left data-focus:bg-muted data-disabled:cursor-not-allowed data-disabled:opacity-40', danger ? 'text-destructive data-focus:bg-destructive/10' : 'text-foreground', className)} />;
}
/** Observe actual Headless state for data refreshes; never maintain a second open state. */
export function MenuOpenObserver({ open, onOpen }: { open: boolean; onOpen?: () => void }) {
  const callback = useRef(onOpen);
  useEffect(() => { callback.current = onOpen; }, [onOpen]);
  useEffect(() => { if (open) callback.current?.(); }, [open]);
  return null;
}
