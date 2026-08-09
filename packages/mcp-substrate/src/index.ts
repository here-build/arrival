export * from "./args-failure-tracker.js";
export * from "./args-misuse.js";
export * from "./args-misuse-door.js";
export * from "./attachment-sink.js";
export * from "./bound-tool.js";
export * from "./calibration.js";
export * from "./content-block.js";
export * from "./doors.js";
export * from "./example-call.js";
export * from "./futility.js";
export * from "./render-observation.js";
export * from "./repl-event.js";
export * from "./repl-fold.js";
export * from "./runner.js";
export * from "./scope-scan.js";
export * from "./session-history.js";
export * from "./session-store.js";
export * from "./statement-facts.js";
export * from "./strategies.js";
export * from "./tool-schema.js";
export * from "./type-hints/index.js";

// The `display` affordance — a HOST verb, not a language feature (arrival has no IO by design).
// The runner rewrites `(display …)` call forms; the composing host must BIND `displaySymbol()` into
// its capability, or the rewrite targets a name nothing declares.
export { displaySymbol, stripTopLevelDisplay, DISPLAY, DISPLAY_INTERNAL } from "./display.js";
