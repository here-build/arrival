/**
 * @here.build/arrival-scheme-env-loader — the arrival-scheme `(require …)` module
 * system. See README. Public surface = the four modules below, re-exported whole.
 * `arrivalLoaderCapability` (loader-capability.ts) is the declarative face — the one
 * EnvCapability an assembling consumer roots; the sibling modules carry the machinery.
 */
export * from "./loader.js";
export * from "./loader-extensions.js";
export * from "./loader-capability.js";
