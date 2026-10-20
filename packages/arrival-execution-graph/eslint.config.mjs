import { browser, reactConfig } from "@here.build/eslint-configs";
// eslint-disable-next-line import-x/no-relative-packages -- repo-root overlay, not a package
import { arrivalOverlay } from "../../eslint.arrival.mjs";

export default [
  ...browser,
  ...reactConfig,
  ...arrivalOverlay({
    tsconfigRootDir: import.meta.dirname,
    extraIgnores: ["storybook-static/**"],
    extraConfigs: [
      {
        // A deliberate String wrapper: the preview of a boxed string.
        files: ["src/__tests__/**"],
        rules: { "sonarjs/no-primitive-wrappers": "off" },
      },
    ],
  }),
];
