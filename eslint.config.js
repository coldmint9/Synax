import js from "@eslint/js";
import tseslint from "typescript-eslint";

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
);
