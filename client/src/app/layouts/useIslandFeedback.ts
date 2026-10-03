import { useEffect, useRef, type MouseEvent } from 'react';
import type { gsap } from 'gsap';
import { loadMotion, reducedMotion } from '../../shared/design/motion';

/** Delegated click feedback also covers keyboard activation without changing control semantics. */
export function useIslandFeedback() {
  const state = useRef({ alive: true, engine: null as typeof gsap | null, targets: new Set<HTMLElement>() });
  useEffect(() => {
    const current = state.current;
    current.alive = true;
    return () => {
      current.alive = false;
      for (const target of current.targets) current.engine?.killTweensOf(target);
      current.targets.clear();
    };
  }, []);
  return (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>('button, [role="radio"], select') : null;
    if (!target || !event.currentTarget.contains(target) || target.matches(':disabled, [aria-disabled="true"]') || reducedMotion()) return;
    const current = state.current;
    void loadMotion().then((motion) => {
      if (!current.alive || !target.isConnected || reducedMotion()) return;
      current.engine = motion;
      current.targets.add(target);
      motion.killTweensOf(target);
      motion.fromTo(target, { y: 1.5, scale: .96 }, {
        y: 0, scale: 1, duration: .28, ease: 'power3.out', overwrite: true,
        clearProps: 'transform', onComplete: () => { current.targets.delete(target); },
      });
    }).catch(() => { /* Click feedback is decorative; activation already completed. */ });
  };
}
