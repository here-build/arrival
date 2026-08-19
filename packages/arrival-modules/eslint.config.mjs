import { nodejs } from "@here.build/eslint-configs";

export default [
  ...nodejs,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["vitest.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
