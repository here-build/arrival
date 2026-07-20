// The `/env` subpath. Two strata share this one home — "environment as an explicit
// product" is what the phase-decomposed exec path is about, so the phase products belong
// on the env subpath alongside the assembly kernel: NOT the root barrel, NOT a new
// `/advanced` subpath.
//
//   • the CAPABILITY-DAG ASSEMBLY KERNEL (common/kernel.ts) — `assembleEnv`, packs,
//     the runtime assembler, the assembly errors. The subpath's original face.
//   • the EXEC PHASE PRODUCTS — `parseProgram` → `ParsedProgram` (phase 1),
//     `assembleAmbient` → `AssembledAmbient` (phase 2, `AsyncDisposable`, carrying the
//     `describeSymbol`/`catalog` metadata read surface — the describe-time read channel,
//     common/symbols/metadata.ts DESCRIBE-TIME READ CHANNEL),
//     `validateAgainstAmbient`/`classifyProgram` (the pure phase-2.5 passes), and the
//     `ExecInstance` type (phase 3). `exec(code, { ambient, program, scope })` composes
//     them; the barrel keeps only the simple cases.
//
// Everything is re-exported EXPLICITLY (no star) so the public surface of the subpath is
// visible at this barrel — same convention as the package root.

// ── the assembly kernel — the subpath's original face ──
export {
  assembleEnv,
  createRuntimeAssembler,
  AssembleConfigConflictError,
  AssembleCycleError,
  AssemblePackError,
  AssembleLinearizationError,
  AssemblePackTimeoutError,
  type EnvPack,
  type PackContext,
  type PreludeBindTarget,
  type AssembledEnv,
  type RuntimeAssembler,
  type DegradedNeed,
  type DegradedCapability,
} from "../common/kernel.js";

// ── the exec phase products ─────────────────────────────────────────────────────────────
export {
  parseProgram,
  validateAgainstAmbient,
  classifyProgram,
  classifierFromAmbient,
  type ParsedProgram,
  type AssembledAmbient,
  type ExecInstance,
  type SymbolDescription,
} from "../eval/exec-phases.js";
export { assembleAmbient, type AssembleAmbientOptions } from "../eval/generator-exec.js";

// The read-time metadata resolver rides the same surface (its declaration-side types live
// on `/symbol`) — an ambient consumer resolving a def's bag by hand reaches it here too.
export { resolveMetadata, staticMetadata, type ResolvedMetadata } from "../common/symbols/metadata.js";
