import js from "@eslint/js";
import globals from "globals";
import svelte from "eslint-plugin-svelte";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "build/**",
      ".svelte-kit/**",
      "node_modules/**",
      "coverage/**",
      "src-tauri/target/**",
      "src-tauri/gen/**",
      "src/bindings.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs["flat/recommended"],
  {
    files: ["**/*.svelte"],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    files: ["**/*.{js,mjs,ts,svelte}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
);
