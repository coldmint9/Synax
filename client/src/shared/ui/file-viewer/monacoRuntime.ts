import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import "monaco-editor/features/find/register.js";
import "monaco-editor/features/clipboard/register.js";
import "monaco-editor/features/folding/register.js";
import "monaco-editor/features/tokenization/register.js";

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
