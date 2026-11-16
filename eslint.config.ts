import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import { flatConfigs as importX } from "eslint-plugin-import-x";
import { configs as perfectionist } from "eslint-plugin-perfectionist";
import { configs as regexp } from "eslint-plugin-regexp";
import security from "eslint-plugin-security";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([".cache/", ".local/", ".wrangler/", "dist/"]),
  {
    files: ["**/*.ts"],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      importX.recommended,
      perfectionist["recommended-natural"],
      regexp["flat/recommended"],
      security.configs.recommended,

      unicorn.configs.recommended,
      prettier,
    ],
    plugins: { sonarjs },
    languageOptions: { parserOptions: { projectService: true } },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "^_" }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/return-await": ["error", "always"],
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      complexity: ["error", 14],
      curly: ["error", "all"],
      "import-x/no-cycle": "error",
      "import-x/no-default-export": "error",
      "import-x/no-unresolved": "off",
      "max-depth": ["error", 3],
      "max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 65, skipBlankLines: true, skipComments: true }],
      "max-params": ["error", 3],
      "no-console": "error",
      "no-param-reassign": "error",
      "perfectionist/sort-objects": "off",
      "perfectionist/sort-object-types": "off",
      "security/detect-object-injection": "off",
      "sonarjs/cognitive-complexity": ["error", 15],
      "sonarjs/deprecation": "off",
      "unicorn/filename-case": ["error", { case: "kebabCase" }],
      "unicorn/no-null": "off",
      // Keep validation in input-to-output order and callbacks direct when they take one argument.
      "unicorn/no-array-callback-reference": "off",
      "unicorn/prefer-simple-condition-first": "off",
      "unicorn/name-replacements": "off",
      "unicorn/prevent-abbreviations": "off",
    },
  },
  {
    files: ["src/worker.ts", "eslint.config.ts"],
    rules: { "import-x/no-default-export": "off" },
  },
  {
    files: ["tests/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "max-lines-per-function": "off",
      "no-console": "off",
      "security/detect-non-literal-fs-filename": "off",
      "unicorn/no-process-exit": "off",
      "unicorn/max-nested-calls": "off",
      "sonarjs/no-duplicate-string": "off",
    },
  },
]);
