/**
 * Small host-owned design layer for conversation prototypes.
 *
 * Prototype authors can use the same restrained primitives as an inline
 * visualization without shipping a second UI framework or depending on a CDN.
 * The stylesheet is part of the compiler-owned HTML, so React/HTML previews
 * never fall back to browser-default controls just because an author omitted a
 * reset or a local stylesheet import.
 */
export function visualizationStyles(): string {
  return String.raw`
:root {
  color-scheme: light;
  --viz-bg: #ffffff;
  --viz-surface: #ffffff;
  --viz-surface-muted: #f6f8f7;
  --viz-surface-soft: #eef4ef;
  --viz-border: #dce5df;
  --viz-border-strong: #c9d7cd;
  --viz-fg: #1f2b24;
  --viz-fg-muted: #6d7b72;
  --viz-primary: #2f6b4a;
  --viz-primary-strong: #24583c;
  --viz-primary-soft: #e5f0e8;
  --viz-danger: #bd4a4a;
  --viz-radius: 12px;
  --viz-shadow: 0 8px 24px rgb(27 45 34 / 7%);
  --viz-font: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-family: var(--viz-font);
  background: var(--viz-bg);
  color: var(--viz-fg);
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --viz-bg: #151b17;
  --viz-surface: #1d2620;
  --viz-surface-muted: #202b24;
  --viz-surface-soft: #26392c;
  --viz-border: #35463a;
  --viz-border-strong: #4a604f;
  --viz-fg: #edf4ef;
  --viz-fg-muted: #a3b3a8;
  --viz-primary: #8fc5a1;
  --viz-primary-strong: #b2ddbd;
  --viz-primary-soft: #294232;
  --viz-danger: #ff9a9a;
  --viz-shadow: 0 12px 30px rgb(0 0 0 / 24%);
}
*, *::before, *::after { box-sizing: border-box; }
html, body { min-width: 0; min-height: 100%; margin: 0; }
body { background: var(--viz-bg); color: var(--viz-fg); font: 14px/1.55 var(--viz-font); padding: 24px; }
button, input, select, textarea { font: inherit; color: inherit; }
button {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  min-height: 36px; padding: 8px 14px; border: 1px solid var(--viz-border-strong);
  border-radius: 9px; background: var(--viz-surface); color: var(--viz-fg); cursor: pointer;
  transition: background 160ms ease, border-color 160ms ease, transform 160ms ease;
}
button:hover { border-color: var(--viz-primary); background: var(--viz-surface-soft); }
button:active { transform: translateY(1px); }
h1, h2, h3, h4 { color: var(--viz-fg); letter-spacing: -.02em; }
h1 { margin: 0 0 16px; font-size: clamp(28px, 5vw, 52px); line-height: 1.08; }
h2 { margin: 28px 0 12px; font-size: clamp(21px, 3vw, 32px); line-height: 1.15; }
h3 { margin: 20px 0 8px; font-size: 18px; }
p { margin: 0 0 14px; color: var(--viz-fg-muted); }
ul, ol { padding-left: 1.35em; }
a { color: var(--viz-primary-strong); text-underline-offset: 3px; }
button, [role="button"], a { -webkit-tap-highlight-color: transparent; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, a:focus-visible { outline: 2px solid var(--viz-primary); outline-offset: 2px; }
img, svg, canvas { max-width: 100%; }

/* Host primitives used by visualize-style prototypes. */
.viz-shell { min-height: 100%; padding: 24px; background: var(--viz-bg); color: var(--viz-fg); }
.viz-container { width: min(100%, 1080px); margin: 0 auto; }
.viz-card, .card { border: 1px solid var(--viz-border); border-radius: var(--viz-radius); background: var(--viz-surface); box-shadow: var(--viz-shadow); }
.viz-surface { background: var(--viz-surface); border: 1px solid var(--viz-border); border-radius: var(--viz-radius); }
.viz-muted, .text-muted { color: var(--viz-fg-muted); }
.viz-eyebrow { color: var(--viz-fg-muted); font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.viz-title { margin: 0; color: var(--viz-fg); font-size: clamp(24px, 4vw, 48px); line-height: 1.08; letter-spacing: -.035em; }
.viz-subtitle { margin: 10px 0 0; color: var(--viz-fg-muted); font-size: 15px; }
.viz-stack { display: flex; flex-direction: column; gap: 16px; }
.viz-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.viz-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }

.viz-button, .btn, .btn-primary, .btn-secondary {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  min-height: 36px; padding: 8px 14px; border: 1px solid var(--viz-border-strong);
  border-radius: 9px; background: var(--viz-surface); color: var(--viz-fg);
  cursor: pointer; text-decoration: none; transition: background 160ms ease, border-color 160ms ease, transform 160ms ease;
}
.viz-button:hover, .btn:hover, .btn-primary:hover, .btn-secondary:hover { border-color: var(--viz-primary); background: var(--viz-surface-soft); }
.viz-button:active, .btn:active, .btn-primary:active, .btn-secondary:active { transform: translateY(1px); }
.viz-button--primary, .btn-primary { border-color: var(--viz-primary); background: var(--viz-primary); color: #fff; }
.viz-button--primary:hover, .btn-primary:hover { border-color: var(--viz-primary-strong); background: var(--viz-primary-strong); }
.viz-button--ghost { border-color: transparent; background: transparent; }
.viz-button:disabled, .btn:disabled { cursor: not-allowed; opacity: .55; }

.viz-input, .form-control, .form-select, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), select, textarea {
  width: 100%; min-height: 36px; padding: 8px 10px; border: 1px solid var(--viz-border-strong);
  border-radius: 8px; background: var(--viz-surface); color: var(--viz-fg);
}
.viz-label, .form-label { display: block; margin-bottom: 6px; color: var(--viz-fg-muted); font-size: 12px; font-weight: 650; }
.viz-field { display: grid; gap: 6px; }
.viz-badge { display: inline-flex; align-items: center; min-height: 24px; padding: 3px 8px; border-radius: 999px; background: var(--viz-primary-soft); color: var(--viz-primary-strong); font-size: 12px; font-weight: 650; }
.viz-divider { height: 1px; background: var(--viz-border); }
.viz-table, .table { width: 100%; border-collapse: collapse; }
.viz-table th, .viz-table td, .table th, .table td { padding: 10px 12px; border-bottom: 1px solid var(--viz-border); text-align: left; }
.viz-table th, .table th { color: var(--viz-fg-muted); font-size: 12px; font-weight: 700; }

@media (max-width: 640px) {
  .viz-shell { padding: 16px; }
  .viz-grid { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
`;
}
