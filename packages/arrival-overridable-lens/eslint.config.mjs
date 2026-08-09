import { nodejs } from "@here.build/eslint-configs";

export default [
  ...nodejs,
  {
    languageOptions: {
      parserOptions: {
        // Root-level config files (vitest.config.ts) sit outside tsconfig's
        // `src/` include — lint them against the default project instead.
        projectService: { allowDefaultProject: ["vitest.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
