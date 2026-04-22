import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Playwright + small TS surface under `e2e/`.
 * Use `npx eslint .` if you add broader file globs later (slow on first run).
 */
export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["e2e/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
);
