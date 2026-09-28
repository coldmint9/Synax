import { Description, Dialog as HeadlessDialog, DialogBackdrop, DialogPanel as HeadlessPanel, DialogTitle as HeadlessTitle, type DialogProps as HeadlessDialogProps } from '@headlessui/react';
import clsx from 'clsx';
import { AlertTriangle, X } from 'lucide-react';
import { createContext, forwardRef, useContext, type HTMLAttributes, type ReactNode } from 'react';
import { CloseButton, type ButtonProps } from './Button';

export type DialogProps = Omit<HeadlessDialogProps<'div'>, 'as' | 'open' | 'onClose' | 'className' | 'children'> & {
  open: boolean;
  onClose: () => void;
  dismissible?: boolean;
  className?: string;
  children: ReactNode;
};
const Surface = createContext<'dialog' | 'drawer'>('dialog');
function DialogRoot({ open, onClose, dismissible = true, className, children, surface = 'dialog', placement = 'right', ...props }: DialogProps & { surface?: 'dialog' | 'drawer'; placement?: 'left' | 'right' }) {
  return <HeadlessDialog {...props} open={open} onClose={() => { if (dismissible) onClose(); }} data-surface={surface} className={clsx('ui-dialog-root relative z-[1000]', className)}>
    <DialogBackdrop className="fixed inset-0 bg-black/35" />
    <div className={clsx('ui-dialog-viewport fixed inset-0 flex min-h-0 overflow-y-auto overscroll-contain', surface === 'drawer' ? (placement === 'right' ? 'items-stretch justify-end' : 'items-stretch justify-start') : 'items-center justify-center p-3 sm:p-6')}>
      <Surface.Provider value={surface}>{children}</Surface.Provider>
    </div>
  </HeadlessDialog>;
}
export function Dialog(props: DialogProps) { return <DialogRoot {...props} />; }
export function AlertDialog(props: Omit<DialogProps, 'role'>) { return <DialogRoot {...props} role="alertdialog" />; }
export function Drawer(props: Omit<DialogProps, 'role'> & { placement?: 'left' | 'right' }) { return <DialogRoot {...props} surface="drawer" />; }

const sizes = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' };
export function DialogContainer({ size = 'md', className, ...props }: HTMLAttributes<HTMLDivElement> & { size?: keyof typeof sizes }) {
  const surface = useContext(Surface);
  return <div {...props} className={clsx('ui-dialog-container flex min-w-0 w-full', sizes[size], surface === 'drawer' && 'h-full', className)} />;
}
export const DialogPanel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function DialogPanel({ className, ...props }, ref) {
  const surface = useContext(Surface);
  return <HeadlessPanel {...props} ref={ref} className={clsx('ui-dialog-panel relative flex min-h-0 min-w-0 w-full flex-col gap-4 border border-border bg-card p-5 text-card-foreground shadow-xl outline-none', surface === 'drawer' ? 'h-full border-y-0' : 'max-h-[calc(100dvh-24px)] rounded-2xl sm:max-h-[calc(100dvh-48px)]', className)} />;
});
export function DialogTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <HeadlessTitle {...props} as="h2" className={clsx('ui-dialog-title min-w-0 text-base font-semibold leading-snug', className)} />;
}
export function DialogDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <Description {...props} as="p" className={clsx('text-sm text-muted-foreground', className)} />;
}
export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={clsx('ui-dialog-header flex shrink-0 flex-wrap items-center gap-3 pr-7', className)} />;
}
export function DialogBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={clsx('ui-dialog-body min-h-0 min-w-0 overflow-y-auto overscroll-contain text-sm', className)} />;
}
export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={clsx('ui-dialog-footer flex shrink-0 flex-wrap items-center justify-end gap-2', className)} />;
}
export function DialogIcon({ tone = 'default', className, children, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: 'default' | 'danger' }) {
  return <span {...props} aria-hidden="true" className={clsx('inline-flex size-9 shrink-0 items-center justify-center rounded-xl', tone === 'danger' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-foreground', className)}>{children ?? (tone === 'danger' ? <AlertTriangle size={18} /> : null)}</span>;
}
export function DialogCloseButton({ className, 'aria-label': label = 'Close', ...props }: Omit<ButtonProps, 'children'>) {
  return <CloseButton {...props} iconOnly size="sm" variant="ghost" aria-label={label} className={clsx('absolute right-3 top-3', className)}><X size={15} aria-hidden="true" /></CloseButton>;
}
