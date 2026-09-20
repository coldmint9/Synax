import { create } from "zustand";
import type {
  DesktopAppearance,
  DesktopAppearanceAPI,
  DesktopAppearancePatch,
} from "../../../../electron/appearance-contract";

export function desktopAppearanceAPI(): DesktopAppearanceAPI | undefined {
  return (
    window as unknown as { electronAPI?: { appearance?: DesktopAppearanceAPI } }
  ).electronAPI?.appearance;
}

interface DesktopAppearanceState {
  settings: DesktopAppearance | null;
  error: string | null;
  busy: boolean;
  load: () => Promise<void>;
  preview: (patch: DesktopAppearancePatch) => void;
  update: (patch: DesktopAppearancePatch) => Promise<void>;
  chooseBackground: () => Promise<void>;
  removeBackground: () => Promise<void>;
}

let revision = 0;
let previewFrame: number | null = null;
let pendingPreview: DesktopAppearancePatch | null = null;
export const useDesktopAppearance = create<DesktopAppearanceState>(
  (set, get) => {
    const flushPreview = () => {
      if (previewFrame !== null) cancelAnimationFrame(previewFrame);
      previewFrame = null;
      const patch = pendingPreview;
      pendingPreview = null;
      const settings = get().settings;
      if (patch && settings) set({ settings: { ...settings, ...patch } });
    };
    const perform = async (
      action: (api: DesktopAppearanceAPI) => Promise<DesktopAppearance | null>,
      blocking = true,
    ) => {
      flushPreview();
      const api = desktopAppearanceAPI();
      if (!api) return;
      const current = ++revision;
      set({ error: null, ...(blocking ? { busy: true } : {}) });
      try {
        const settings = await action(api);
        if (current === revision && settings) set({ settings });
      } catch (error) {
        if (current !== revision) return;
        set({ error: error instanceof Error ? error.message : String(error) });
        // Restore only the background draft; foreground UI is never dimmed.
        try {
          const settings = await api.get();
          if (current === revision) {
            set({ settings });
          }
        } catch {
          /* Keep the last visible state and expose the error. */
        }
      } finally {
        if (blocking) set({ busy: false });
      }
    };
    return {
      settings: null,
      error: null,
      busy: false,
      load: () => perform((api) => api.get()),
      preview: (patch) => {
        if (!get().settings) return;
        revision++;
        pendingPreview = { ...pendingPreview, ...patch };
        if (previewFrame === null)
          previewFrame = requestAnimationFrame(flushPreview);
      },
      update: (patch) => {
        pendingPreview = { ...pendingPreview, ...patch };
        return perform((api) => api.update(patch), false);
      },
      chooseBackground: () => perform((api) => api.chooseBackground()),
      removeBackground: () => perform((api) => api.removeBackground()),
    };
  },
);
