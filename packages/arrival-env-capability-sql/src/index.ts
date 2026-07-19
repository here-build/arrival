// arrival-env-capability-sql — the sql effect family as a self-contained capability pack:
// the SqlEffect intent descriptor + narrow resolver seam (sql-effect.ts) and the
// `arrival/sql` EnvCapability verb (sql-capability.ts). Composed into the DataEffect
// union by `@inhuman.tools/arrival-effects`; rooted by arrival-run's default root-set.
export * from "./sql-effect.js";
export * from "./sql-capability.js";
