import type { gsap as Gsap } from 'gsap';

let engine: Promise<typeof Gsap> | undefined;
/** The workbench loads motion once; ordinary controls and reduced-motion views do not. */
export function loadMotion(): Promise<typeof Gsap> {
  if (engine) return engine;
  const pending = import('gsap').then(({ gsap }) => {
    gsap.config({ autoSleep: 12 });
    return gsap;
  });
  engine = pending;
  void pending.catch(() => { if (engine === pending) engine = undefined; });
  return pending;
}
export function reducedMotion(): boolean {
  return typeof window === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
