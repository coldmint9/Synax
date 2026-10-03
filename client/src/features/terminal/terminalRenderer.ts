import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

export type TerminalRenderer = "webgl" | "dom";

type WebglLike = Pick<WebglAddon, "dispose" | "onContextLoss">;
type TerminalLike = Pick<Terminal, "loadAddon">;

/** Load the GPU renderer when available and let xterm restore its DOM renderer
 * if WebGL cannot start or the graphics context is lost. */
export function enableWebglRenderer(
  terminal: TerminalLike,
  setRenderer: (renderer: TerminalRenderer) => void,
  create: () => WebglLike = () => new WebglAddon(),
): WebglLike | undefined {
  let addon: WebglLike | undefined;
  try {
    addon = create();
    terminal.loadAddon(addon as WebglAddon);
    addon.onContextLoss(() => {
      addon?.dispose();
      addon = undefined;
      setRenderer("dom");
    });
    setRenderer("webgl");
    return addon;
  } catch {
    addon?.dispose();
    setRenderer("dom");
    return undefined;
  }
}
