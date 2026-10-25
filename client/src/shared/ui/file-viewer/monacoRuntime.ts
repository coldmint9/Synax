import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import "monaco-editor/features/find/register.js";
import "monaco-editor/features/clipboard/register.js";
import "monaco-editor/features/folding/register.js";
import "monaco-editor/features/tokenization/register.js";

const MONACO_ATOM_LIGHT = "synax-atom-light";
const MONACO_ATOM_DARK = "synax-atom-dark";

let atomThemesReady = false;

/**
 * Atom One Light/Dark palettes keep every Monaco surface in the same visual
 * language as the code viewer while preserving Monaco's native diff markers.
 */
function ensureAtomThemes() {
  if (atomThemesReady) return;
  monaco.editor.defineTheme(MONACO_ATOM_LIGHT, {
    base: "vs",
    inherit: false,
    colors: {
      "editor.background": "#fafafa",
      "editor.foreground": "#383a42",
      "editorLineNumber.foreground": "#9da5b4",
      "editorLineNumber.activeForeground": "#383a42",
      "editorCursor.foreground": "#526fff",
      "editor.selectionBackground": "#d7d7d7",
      "editor.inactiveSelectionBackground": "#e5e5e6",
      "editorIndentGuide.background": "#e5e5e6",
      "editorIndentGuide.activeBackground": "#c8c8c8",
      "editorGutter.background": "#fafafa",
      "editorWidget.background": "#f2f2f2",
      "editorWidget.border": "#d4d4d4",
      "editorHoverWidget.background": "#f2f2f2",
      "editorHoverWidget.border": "#d4d4d4",
      "diffEditor.insertedTextBackground": "#50a14f22",
      "diffEditor.removedTextBackground": "#e4564922",
      "diffEditor.insertedLineBackground": "#50a14f12",
      "diffEditor.removedLineBackground": "#e4564912",
      "diffEditorOverview.insertedForeground": "#50a14f",
      "diffEditorOverview.removedForeground": "#e45649",
      "editorOverviewRuler.addedForeground": "#50a14f",
      "editorOverviewRuler.deletedForeground": "#e45649",
    },
    rules: [
      { token: "comment", foreground: "a0a1a7", fontStyle: "italic" },
      { token: "keyword", foreground: "a626a4" },
      { token: "storage", foreground: "a626a4" },
      { token: "string", foreground: "50a14f" },
      { token: "string.escape", foreground: "986801" },
      { token: "number", foreground: "986801" },
      { token: "constant", foreground: "986801" },
      { token: "type", foreground: "c18401" },
      { token: "type.identifier", foreground: "c18401" },
      { token: "class", foreground: "c18401" },
      { token: "function", foreground: "4078f2" },
      { token: "function.call", foreground: "4078f2" },
      { token: "variable", foreground: "e45649" },
      { token: "delimiter", foreground: "383a42" },
      { token: "delimiter.bracket", foreground: "383a42" },
    ],
  });
  monaco.editor.defineTheme(MONACO_ATOM_DARK, {
    base: "vs-dark",
    inherit: false,
    colors: {
      "editor.background": "#282c34",
      "editor.foreground": "#abb2bf",
      "editorLineNumber.foreground": "#636d83",
      "editorLineNumber.activeForeground": "#abb2bf",
      "editorCursor.foreground": "#528bff",
      "editor.selectionBackground": "#3e4451",
      "editor.inactiveSelectionBackground": "#323842",
      "editorIndentGuide.background": "#3b4048",
      "editorIndentGuide.activeBackground": "#4b5263",
      "editorGutter.background": "#282c34",
      "editorWidget.background": "#21252b",
      "editorWidget.border": "#181a1f",
      "editorHoverWidget.background": "#21252b",
      "editorHoverWidget.border": "#181a1f",
      "diffEditor.insertedTextBackground": "#98c37925",
      "diffEditor.removedTextBackground": "#e06c7525",
      "diffEditor.insertedLineBackground": "#98c37914",
      "diffEditor.removedLineBackground": "#e06c7514",
      "diffEditorOverview.insertedForeground": "#98c379",
      "diffEditorOverview.removedForeground": "#e06c75",
      "editorOverviewRuler.addedForeground": "#98c379",
      "editorOverviewRuler.deletedForeground": "#e06c75",
    },
    rules: [
      { token: "comment", foreground: "5c6370", fontStyle: "italic" },
      { token: "keyword", foreground: "c678dd" },
      { token: "storage", foreground: "c678dd" },
      { token: "string", foreground: "98c379" },
      { token: "string.escape", foreground: "56b6c2" },
      { token: "number", foreground: "d19a66" },
      { token: "constant", foreground: "d19a66" },
      { token: "type", foreground: "e5c07b" },
      { token: "type.identifier", foreground: "e5c07b" },
      { token: "class", foreground: "e5c07b" },
      { token: "function", foreground: "61afef" },
      { token: "function.call", foreground: "61afef" },
      { token: "variable", foreground: "e06c75" },
      { token: "delimiter", foreground: "abb2bf" },
      { token: "delimiter.bracket", foreground: "abb2bf" },
    ],
  });
  atomThemesReady = true;
}

function isDarkAppearance(scope?: HTMLElement): boolean {
  const root = document.documentElement;
  if (
    root.classList.contains("dark") ||
    root.dataset.theme === "dark" ||
    root.getAttribute("data-color-scheme") === "dark"
  ) {
    return true;
  }
  const color = scope
    ? getComputedStyle(scope).getPropertyValue("--theme-text").trim()
    : getComputedStyle(root).getPropertyValue("--theme-text").trim();
  return color.startsWith("#") && parseInt(color.slice(1, 3), 16) > 160;
}

export function applyMonacoTheme(scope?: HTMLElement): string {
  ensureAtomThemes();
  const theme = isDarkAppearance(scope) ? MONACO_ATOM_DARK : MONACO_ATOM_LIGHT;
  monaco.editor.setTheme(theme);
  return theme;
}

export const monacoThemeNames = {
  light: MONACO_ATOM_LIGHT,
  dark: MONACO_ATOM_DARK,
} as const;

type MonacoEnvironment = {
  getWorker: (_moduleId: string, label: string) => Worker;
};
const environment = globalThis as typeof globalThis & {
  MonacoEnvironment?: MonacoEnvironment;
};
// Monaco owns its shared editor worker and idle timeout. A workbench owns only
// its models/editors and analysis worker; it must not kill a worker used by another view.
environment.MonacoEnvironment ??= { getWorker: () => new EditorWorker() };

const extensions: Record<string, string> = {
  java: "java",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rs: "rust",
  go: "go",
  xml: "xml",
  yml: "yaml",
  yaml: "yaml",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  md: "markdown",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  kt: "kotlin",
  rb: "ruby",
  php: "php",
  swift: "swift",
};
const registrations = {
  java: () => import("monaco-editor/languages/definitions/java/register.js"),
  javascript: () =>
    import("monaco-editor/languages/definitions/javascript/register.js"),
  typescript: () =>
    import("monaco-editor/languages/definitions/typescript/register.js"),
  python: () =>
    import("monaco-editor/languages/definitions/python/register.js"),
  rust: () => import("monaco-editor/languages/definitions/rust/register.js"),
  go: () => import("monaco-editor/languages/definitions/go/register.js"),
  xml: () => import("monaco-editor/languages/definitions/xml/register.js"),
  yaml: () => import("monaco-editor/languages/definitions/yaml/register.js"),
  css: () => import("monaco-editor/languages/definitions/css/register.js"),
  scss: () => import("monaco-editor/languages/definitions/scss/register.js"),
  html: () => import("monaco-editor/languages/definitions/html/register.js"),
  markdown: () =>
    import("monaco-editor/languages/definitions/markdown/register.js"),
  sql: () => import("monaco-editor/languages/definitions/sql/register.js"),
  shell: () => import("monaco-editor/languages/definitions/shell/register.js"),
  cpp: () => import("monaco-editor/languages/definitions/cpp/register.js"),
  csharp: () =>
    import("monaco-editor/languages/definitions/csharp/register.js"),
  kotlin: () =>
    import("monaco-editor/languages/definitions/kotlin/register.js"),
  ruby: () => import("monaco-editor/languages/definitions/ruby/register.js"),
  php: () => import("monaco-editor/languages/definitions/php/register.js"),
  swift: () => import("monaco-editor/languages/definitions/swift/register.js"),
};
const loading = new Map<string, Promise<unknown>>();

export async function languageForPath(path: string): Promise<string> {
  const extension =
    path.split(/[?#]/)[0].split(".").slice(-1)[0]?.toLowerCase() ?? "";
  // JSON tokenization does not need the heavyweight diagnostics worker.
  if (extension === "json" || extension === "jsonc") {
    if (
      !monaco.languages
        .getLanguages()
        .some((language) => language.id === "json")
    ) {
      monaco.languages.register({ id: "json" });
      monaco.languages.setMonarchTokensProvider("json", {
        tokenizer: {
          root: [
            [/\/\*/, "comment", "@comment"],
            [/"([^"\\]|\\.)*"(?=\s*:)/, "type.identifier"],
            [/"([^"\\]|\\.)*"/, "string"],
            [/-?\d+(\.\d+)?([eE][+-]?\d+)?/, "number"],
            [/\b(true|false|null)\b/, "keyword"],
            [/\/\/.*$/, "comment"],
            [/[{}\[\],:]/, "delimiter"],
          ],
          comment: [
            [/[^/*]+/, "comment"],
            [/\*\//, "comment", "@pop"],
            [/[/*]/, "comment"],
          ],
        },
      });
    }
    return "json";
  }
  const language = extensions[extension] as
    | keyof typeof registrations
    | undefined;
  if (!language) return "plaintext";
  let promise = loading.get(language);
  if (!promise) {
    promise = registrations[language]().catch((error) => {
      loading.delete(language);
      throw error;
    });
    loading.set(language, promise);
  }
  await promise;
  return language;
}

export { monaco };
