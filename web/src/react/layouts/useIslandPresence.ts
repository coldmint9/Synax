import { useLayoutEffect, useRef, useState } from 'react';
import { loadMotion, reducedMotion } from '../design/motion';

/** Retain only the visual exit; the caller still owns focus, dismissal and open state. */
export function useIslandPresence<T extends HTMLElement = HTMLDivElement>(open: boolean) {
  const [present, setPresent] = useState(open);
  const [node, ref] = useState<T | null>(null);
  const entered = useRef(false);
  useLayoutEffect(() => { if (open) setPresent(true); }, [open]);
  useLayoutEffect(() => {
    if (!node || !present) return;
    let disposed = false;
    let epoch = 0;
    let cleanup: (() => void) | undefined;
    const finish = () => {
      if (!disposed && !open) { entered.current = false; setPresent(false); }
    };
    // An optional animation must never leave an accessible panel invisible.
    const settle = () => {
      cleanup?.();
      cleanup = undefined;
      node.style.removeProperty('opacity');
      node.style.removeProperty('transform');
      entered.current = open;
      finish();
    };
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onPreference = () => {
      if (!reducedMotion()) return;
      epoch++;
      settle();
    };
    preference.addEventListener('change', onPreference);
    if (reducedMotion()) settle();
    else {
      if (open && !entered.current) node.style.opacity = '0';
      const current = ++epoch;
      void loadMotion().then((motion) => {
        if (disposed || current !== epoch) return;
        if (reducedMotion()) { settle(); return; }
        if (open && !entered.current) motion.set(node, { y: -7, opacity: 0 });
        entered.current = true;
        motion.to(node, {
          y: open ? 0 : -5, opacity: open ? 1 : 0,
          duration: open ? .24 : .18, ease: 'power3.out', overwrite: true,
          onComplete: finish,
        });
        cleanup = () => motion.killTweensOf(node);
      }).catch(() => {
        if (!disposed && current === epoch) settle();
      });
    }
    return () => {
      disposed = true;
      cleanup?.();
      preference.removeEventListener('change', onPreference);
    };
  }, [open, present, node]);
  return { ref, present };
}
