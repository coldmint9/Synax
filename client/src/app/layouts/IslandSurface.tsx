import { forwardRef, type HTMLAttributes } from 'react';
import clsx from 'clsx';
import { useIslandFeedback } from './useIslandFeedback';
import { LiquidGlassSurface } from '../../shared/ui/ui/LiquidGlassSurface';

export const IslandSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { kind?: 'primary' | 'context' }>(function IslandSurface({ children, className, kind = 'context', onClickCapture, ...props }, ref) {
  const feedback = useIslandFeedback();
  return <div {...props} onClickCapture={(event) => { onClickCapture?.(event); feedback(event); }} ref={ref} data-island-surface="" data-kind={kind} className={clsx('synax-island wh-pill', className)}>
    <LiquidGlassSurface className="synax-island-material" intensity="subtle" finish="flat">{children}</LiquidGlassSurface>
  </div>;
});
