import { Popover as HeadlessPopover, PopoverButton as HeadlessButton, PopoverPanel as HeadlessPanel, type PopoverProps, type PopoverButtonProps, type PopoverPanelProps } from '@headlessui/react';
import clsx from 'clsx';
import { forwardRef } from 'react';

export function Popover({ className, ...props }: Omit<PopoverProps<'div'>, 'as' | 'className'> & { className?: string }) {
  return <HeadlessPopover {...props} as="div" className={clsx('relative inline-flex min-w-0', className)} />;
}
export const PopoverButton = forwardRef<HTMLButtonElement, Omit<PopoverButtonProps<'button'>, 'as' | 'className'> & { className?: string }>(function PopoverButton({ className, ...props }, ref) {
  return <HeadlessButton {...props} ref={ref} className={clsx('inline-flex items-center justify-center gap-1.5 rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring', className)} />;
});
export const PopoverPanel = forwardRef<HTMLDivElement, Omit<PopoverPanelProps<'div'>, 'as' | 'className'> & { className?: string }>(function PopoverPanel({ className, anchor = { to: 'bottom start', gap: 8, padding: 8 }, ...props }, ref) {
  return <HeadlessPanel {...props} ref={ref} anchor={anchor} portal data-slot="popover" className={clsx('ui-popover z-[1200] pointer-events-auto max-w-[calc(100vw-16px)] rounded-xl border border-border bg-card p-3 text-card-foreground shadow-lg outline-none', className)} />;
});
