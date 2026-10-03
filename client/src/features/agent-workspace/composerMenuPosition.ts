import type { CSSProperties } from "react";

/** Anchor to the editor, outside transformed/clipped composer ancestors. */
export function composerMenuPosition(
  anchor: { left: number; top: number; bottom: number; width: number },
  viewport: {
    width: number;
    height: number;
    layoutHeight: number;
    top?: number;
    left?: number;
  },
): CSSProperties {
  const margin = 16,
    gap = 8;
  const viewportTop = viewport.top ?? 0,
    viewportLeft = viewport.left ?? 0;
  const width = Math.max(
    0,
    Math.min(384, anchor.width, viewport.width - margin * 2),
  );
  const left = Math.max(
    viewportLeft + margin,
    Math.min(anchor.left, viewportLeft + viewport.width - width - margin),
  );
  const above = Math.max(0, anchor.top - viewportTop - margin - gap);
  const below = Math.max(
    0,
    viewportTop + viewport.height - anchor.bottom - margin - gap,
  );
  if (above < 160 && below > above)
    return {
      left,
      width,
      top: anchor.bottom + gap,
      maxHeight: Math.min(360, below),
    };
  return {
    left,
    width,
    bottom: viewport.layoutHeight - anchor.top + gap,
    maxHeight: Math.min(360, above),
  };
}
