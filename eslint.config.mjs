import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const ignoredPaths = [
  ".agents/**",
  ".cache/**",
  ".codex/**",
  ".runs/**",
  "coverage/**",
  "dist/**",
  "node_modules/**",
  "out/**",
  "outputs/**",
  "oyster-pitch-deck/**",
  "supabase/.temp/**",
  "tmp/**",
  "ui/dist/**",
  "ui/node_modules/**",
  "vendor/**",
];

export default tseslint.config(
  {
    ignores: ignoredPaths,
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,cjs,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
      sourceType: "module",
    },
  },
  {
    files: ["**/*.{ts,tsx,cts,mts}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["ui/src/**/*.{ts,tsx}", "ui/test/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
    },
  },
  {
    files: ["scripts/codex-worker-probe.mjs", "src/skill/workflow-graph.ts"],
    rules: {
      "no-useless-escape": "off",
    },
  },
  {
    files: ["**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
);
