import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Blob: "readonly",
  Buffer: "readonly",
  FormData: "readonly",
  Headers: "readonly",
  Request: "readonly",
  Response: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  clearImmediate: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  fetch: "readonly",
  module: "readonly",
  performance: "readonly",
  process: "readonly",
  queueMicrotask: "readonly",
  require: "readonly",
  setImmediate: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  structuredClone: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  WebSocket: "readonly",
};

export default tseslint.config(
  {
    ignores: [
      "client/dist/**",
      "dist/**",
      "server-dist/**",
      "cua-helper-dist/**",
      "out/**",
      "tmp/**",
      "node_modules/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{cjs,cts,mjs,mts,js,jsx,ts,tsx}"],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
  {
    files: ["**/*.{cjs,cts}"],
    languageOptions: {
      sourceType: "commonjs",
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    rules: {
      // Existing runtime and test boundaries intentionally carry dynamic values.
      // Keep them visible as warnings while the typed core is migrated incrementally.
      "@typescript-eslint/no-explicit-any": "warn",
      // These rules flag deliberate compatibility and cleanup patterns already
      // used by the runtime, test harnesses, and generated provider payloads.
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "no-constant-binary-expression": "off",
      "no-constant-condition": "off",
      "no-control-regex": "off",
      "no-empty": "off",
      "no-irregular-whitespace": "off",
      "no-unsafe-finally": "off",
      "no-useless-assignment": "off",
      "no-useless-escape": "off",
      "preserve-caught-error": "off",
      "require-yield": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
);
