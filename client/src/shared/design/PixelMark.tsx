import type { SVGProps } from 'react';

const CELLS = ['000111000', '000111000', '001111100', '111101111', '111000111', '111101111', '001111100', '000111000', '000111000'];
/** A small, crisp signature; decoration never competes with the document. */
export function PixelMark({ size = 18, signal = false, ...props }: SVGProps<SVGSVGElement> & { size?: number; signal?: boolean }) {
  return <svg {...props} width={size} height={size} viewBox="0 0 11 11" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
    {CELLS.flatMap((row, y) => [...row].map((cell, x) => cell === '1' ? <rect key={`${x}-${y}`} x={x + 1} y={y + 1} width="1" height="1" fill={signal && x > 5 && y < 4 ? 'var(--ui-signal, #b9cb78)' : undefined} /> : null))}
  </svg>;
}
