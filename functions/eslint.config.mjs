import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

// La mise en forme est laissée à Prettier : ESLint ne vérifie que la qualité du code.
export default tseslint.config(
  {
    // lib : code compilé. src/shared : copie générée depuis le repo front (scripts/sync-shared.mjs).
    ignores: ["lib/**", "src/shared/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  prettier,
);
