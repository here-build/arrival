import { nodejs } from "@here.build/eslint-configs";
// eslint-disable-next-line import-x/no-relative-packages -- repo-root overlay, not a package
import { arrivalOverlay } from "../../eslint.arrival.mjs";

export default [
  ...nodejs,
  ...arrivalOverlay({
    tsconfigRootDir: import.meta.dirname,
    extraIgnores: [".tsgo/**"], // gitignored tsgo wasm build artifacts
  }),
];
