import { vi } from "vitest";

/** A model/host adapter for lifecycle tests. Rendering is verified in browser tests. */
export function createMonacoHarness() {
  const models: any[] = [], editors: any[] = [];
  const api = {
    Uri: { from: (value: unknown) => value }, Range: class { constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) {} },
    KeyMod: { CtrlCmd: 1, Shift: 2 }, KeyCode: { KeyS: 4, F8: 8 },
    editor: {
      OverviewRulerLane: { Full: 1 }, defineTheme: vi.fn(), setTheme: vi.fn(),
      createModel(value: string) {
        let text = value, version = 1;
        const callbacks = new Set<() => void>();
        const model = { getValue: () => text, getValueLength: () => text.length, setValue: (next: string) => { text = next; version++; for (const callback of callbacks) callback(); }, getVersionId: () => version, getLineCount: () => text.split("\n").length, onDidChangeContent: (callback: () => void) => { callbacks.add(callback); return { dispose: () => callbacks.delete(callback) }; }, dispose: vi.fn(() => callbacks.clear()) };
        models.push(model); return model;
      },
      create(host: HTMLElement, options: any) {
        const textarea = document.createElement("textarea"); textarea.setAttribute("aria-label", options.ariaLabel); textarea.value = options.model.getValue(); textarea.readOnly = options.readOnly;
        const input = () => options.model.setValue(textarea.value); textarea.addEventListener("input", input); host.append(textarea);
        const actions = new Map<string, () => void>();
        const findState = { isRevealed: false };
        const findController = {
          getState: () => findState,
          closeFindWidget: () => { findState.isRevealed = false; },
        };
        const change = options.model.onDidChangeContent(() => { textarea.value = options.model.getValue(); });
        const editor = { model: options.model, textarea, actions, layout: vi.fn(), updateOptions: vi.fn((next: any) => { textarea.readOnly = next.readOnly; }), createDecorationsCollection: () => ({ set: vi.fn(), clear: vi.fn() }), addAction: ({ id, run }: any) => { actions.set(id, run); return { dispose: () => actions.delete(id) }; }, onDidBlurEditorWidget: (callback: () => void) => { textarea.addEventListener("blur", callback); return { dispose: () => textarea.removeEventListener("blur", callback) }; }, getContribution: () => findController, trigger: vi.fn((_source: string, action: string) => { if (action === "editor.action.startFindReplaceAction") findState.isRevealed = true; if (action === "closeFindWidget") findState.isRevealed = false; }), saveViewState: vi.fn(() => ({})), restoreViewState: vi.fn(), onDidScrollChange: () => ({ dispose: vi.fn() }), getVisibleRanges: () => [{ startLineNumber: 1 }], getScrollTop: () => 0, getTopForLineNumber: (line: number) => line * 21, setScrollTop: vi.fn(), revealLineInCenter: vi.fn(), setPosition: vi.fn(), focus: vi.fn(), dispose: vi.fn(() => { change.dispose(); textarea.removeEventListener("input", input); textarea.remove(); }) };
        editors.push(editor); return editor;
      },
      createDiffEditor(host: HTMLElement, options: any) {
        const editor = {
          setModel: vi.fn(),
          layout: vi.fn(),
          dispose: vi.fn(() => { host.replaceChildren(); }),
          options,
        };
        editors.push(editor);
        return editor;
      },
    },
  };
  return { monaco: api, models, editors, reset: () => { models.length = 0; editors.length = 0; } };
}
