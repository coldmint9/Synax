import type { ComponentProps } from 'react';
import { MenuItems } from '../../shared/ui/ui/Menu';
import { PopoverPanel } from '../../shared/ui/ui/Popover';
import { useIslandPresence } from './useIslandPresence';

export function IslandMenuItems({ open, ...props }: ComponentProps<typeof MenuItems> & { open: boolean }) {
  const { ref, present } = useIslandPresence(open);
  return present ? <MenuItems {...props} ref={ref} static inert={!open} aria-hidden={!open} /> : null;
}
export function IslandPopoverPanel({ open, ...props }: ComponentProps<typeof PopoverPanel> & { open: boolean }) {
  const { ref, present } = useIslandPresence(open);
  return present ? <PopoverPanel {...props} ref={ref} static inert={!open} aria-hidden={!open} /> : null;
}
