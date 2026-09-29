import { useId, type CSSProperties } from "react";

/** A translucent shoulder ending at, rather than underneath, the input edge. */
export function WorkspaceHillSurface() {
  const clipId = `workspace-hill-${useId().replace(/:/g, "")}`;

  return (
    <>
      <svg className="workspace-hill-defs" aria-hidden="true" focusable="false">
        <defs>
          <clipPath id={clipId} clipPathUnits="objectBoundingBox">
            <path d="M0 1 C.07 1 .11 .89 .15 .66 C.19 .38 .21 .176 .30 .176 L.69 .176 C.78 .176 .80 .38 .84 .66 C.88 .89 .94 1 1 1 Z" />
          </clipPath>
        </defs>
      </svg>
      <span
        className="workspace-hill-surface"
        aria-hidden="true"
        style={{ clipPath: `url(#${clipId})` } as CSSProperties}
      />
    </>
  );
}
