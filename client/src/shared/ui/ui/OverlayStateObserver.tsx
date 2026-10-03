import { useEffect, useLayoutEffect, useRef } from "react";

/** Reports Headless UI's state; never owns or synchronizes overlay state. */
export function OverlayStateObserver({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const listener = useRef(onOpenChange);
  useLayoutEffect(() => {
    listener.current = onOpenChange;
  }, [onOpenChange]);
  useEffect(() => {
    listener.current?.(open);
  }, [open]);
  useEffect(() => () => listener.current?.(false), []);
  return null;
}
