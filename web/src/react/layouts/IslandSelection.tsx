import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { gsap } from 'gsap';
import { loadMotion, reducedMotion } from '../design/motion';

type Geometry = { x: number; y: number; width: number; height: number };

/** Children expose data-island-option keys; ARIA remains owned by their controls. */
export function IslandSelection({ activeKey, children, className = '' }: {
  activeKey: string | null;
  children: ReactNode;
  className?: string;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const selectedKey = useRef(activeKey);
  const applySelection = useRef<(() => void) | null>(null);

  // Never force layout while React is committing a potentially large Wiki page.
  useLayoutEffect(() => { selectedKey.current = activeKey; }, [activeKey]);
  useEffect(() => { applySelection.current?.(); }, [activeKey]);

  useEffect(() => {
    const group = groupRef.current;
    const indicator = indicatorRef.current;
    if (!group || !indicator) return;
    const geometry = new Map<string, Geometry>();
    const options = new Set<HTMLElement>();
    let engine: typeof gsap | null = null;
    let loading = false;
    let unavailable = false;
    let disposed = false;
    let positioned = false;
    let previous = '';
    let baseWidth = 0;
    let baseHeight = 0;

    function apply() {
      if (disposed) return;
      const target = selectedKey.current === null ? undefined : geometry.get(selectedKey.current);
      const reduce = reducedMotion();
      const signature = `${reduce}:${target ? `${target.x}:${target.y}:${target.width}:${target.height}` : 'hidden'}`;
      if (signature === previous) return;
      if (!engine && !reduce && !unavailable && target) {
        if (!loading) {
          loading = true;
          void loadMotion().then((motion) => {
            if (disposed) return;
            engine = motion;
            apply(); // Use the latest key/layout, not a stale DOM ARIA snapshot.
          }).catch(() => {
            if (disposed) return;
            unavailable = true;
            apply(); // Keep the selected option legible without the motion chunk.
          });
        }
        return;
      }
      previous = signature;
      if (!target) {
        if (engine && !reduce) engine.to(indicator, { opacity: 0, duration: .16, overwrite: true });
        else if (engine) { engine.killTweensOf(indicator); engine.set(indicator, { opacity: 0 }); }
        else indicator!.style.opacity = '0';
        positioned = false;
        return;
      }
      if (reduce || !engine || !positioned) {
        const values = { ...target, opacity: 1, scaleX: 1, scaleY: 1, transformOrigin: '0 0' };
        if (engine) { engine.killTweensOf(indicator); engine.set(indicator, values); }
        else Object.assign(indicator!.style, {
          transform: `translate(${target.x}px, ${target.y}px)`,
          width: `${target.width}px`, height: `${target.height}px`, opacity: '1',
        });
      } else if (engine) {
        // FLIP the size once, then animate only compositor transforms/opacity.
        // Retarget from the current scale so rapid clicks never queue or snap.
        if (baseWidth !== target.width || baseHeight !== target.height) {
          const width = baseWidth * Number(engine.getProperty(indicator, 'scaleX'));
          const height = baseHeight * Number(engine.getProperty(indicator, 'scaleY'));
          engine.set(indicator, {
            width: target.width, height: target.height,
            scaleX: width / target.width, scaleY: height / target.height,
          });
        }
        engine.to(indicator, { x: target.x, y: target.y, scaleX: 1, scaleY: 1, opacity: 1, duration: .28, ease: 'power3.out', overwrite: true });
      }
      baseWidth = target.width;
      baseHeight = target.height;
      positioned = true;
    }

    function measure() {
      if (disposed) return;
      // ResizeObserver runs after layout. Collect all reads before writing the pill.
      geometry.clear();
      for (const option of options) {
        const width = option.offsetWidth;
        const height = option.offsetHeight;
        if (width && height) geometry.set(option.dataset.islandOption!, { x: option.offsetLeft, y: option.offsetTop, width, height });
      }
      apply();
    }
    const resize = new ResizeObserver(measure);
    resize.observe(group);
    function observeOptions() {
      if (disposed) return;
      const next = new Set(group!.querySelectorAll<HTMLElement>('[data-island-option]'));
      for (const option of options) if (!next.has(option)) { resize.unobserve(option); options.delete(option); }
      for (const option of next) if (!options.has(option)) { options.add(option); resize.observe(option); }
    }
    observeOptions();
    // New/removed navigation controls get an initial RO delivery even at the same size.
    const childrenObserver = new MutationObserver(observeOptions);
    childrenObserver.observe(group, { childList: true, subtree: true });
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    preference.addEventListener('change', apply);
    applySelection.current = apply;
    return () => {
      disposed = true;
      applySelection.current = null;
      resize.disconnect();
      childrenObserver.disconnect();
      preference.removeEventListener('change', apply);
      engine?.killTweensOf(indicator);
    };
  }, []);

  return <div ref={groupRef} className={`island-selection ${className}`}>
    <span ref={indicatorRef} className="island-selection-pill" data-island-indicator="" aria-hidden="true" />
    {children}
  </div>;
}
