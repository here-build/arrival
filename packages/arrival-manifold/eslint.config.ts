import { nodejs } from "@here.build/eslint-configs";

export default [
  ...nodejs,
  { ignores: ["vitest.config.ts", "vitest.research.config.ts"] },
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
];
