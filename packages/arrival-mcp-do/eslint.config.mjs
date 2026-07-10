import { cloudflare } from "@here.build/eslint-configs";

export default [
  ...cloudflare,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    rules: {
      // Cloudflare's virtual module — workerd-injected, no resolution path.
      "import-x/no-unresolved": ["error", { ignore: ["^cloudflare:"] }],
      // This package names its class-module in kebab-case alongside the arrival-mcp
      // PascalCase convention for classes it re-hosts.
      "unicorn/filename-case": ["error", { cases: { camelCase: true, pascalCase: true, kebabCase: true } }],
    },
  },
  {
    ignores: ["node_modules/*", "dist/*"],
  },
];
