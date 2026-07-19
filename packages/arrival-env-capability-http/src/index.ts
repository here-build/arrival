// arrival-env-capability-http — the http effect family as a self-contained capability pack:
// the HttpEffect intent descriptor + narrow resolver seam (http-effect.ts) and the
// `arrival/http` EnvCapability verbs (http-capability.ts). Composed into the DataEffect
// union by `@inhuman.tools/arrival-effects`; rooted by arrival-run's default root-set.
export * from "./http-effect.js";
export * from "./http-capability.js";
