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
export const useDesktopAppearance = create<DesktopAppearanceState>(
  (set, get) => {
    const perform = async (
      action: (api: DesktopAppearanceAPI) => Promise<DesktopAppearance | null>,
      blocking = true,
    ) => {
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
        // Restore the saved settings and native opacity if a commit failed.
        try {
          const settings = await api.get();
          if (current === revision) {
            set({ settings });
            api.previewOpacity(settings.opacity);
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
        const settings = get().settings;
        if (!settings) return;
        revision++;
        set({ settings: { ...settings, ...patch } });
        if (patch.opacity !== undefined && settings.opacitySupported)
          desktopAppearanceAPI()?.previewOpacity(patch.opacity);
      },
      update: (patch) => perform((api) => api.update(patch), false),
      chooseBackground: () => perform((api) => api.chooseBackground()),
      removeBackground: () => perform((api) => api.removeBackground()),
    };
  },
);
