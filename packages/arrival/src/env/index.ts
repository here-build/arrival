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
// The barrel imports each symbol from its REAL home, not through a passthrough: the
// assembly machinery from the kernel, the errors from the single error home (errors.ts),
// the degradation types from the degradation domain (common/degradation.ts). This is the
// one place the surface is re-collected; the intermediate modules stay leaf.
export {
  assembleEnv,
  createRuntimeAssembler,
  type EnvPack,
  type PackContext,
  type PreludeBindTarget,
  type AssembledEnv,
  type RuntimeAssembler,
} from "../common/kernel.js";
export {
  AssembleConfigConflictError,
  AssembleCycleError,
  AssemblePackError,
  AssembleLinearizationError,
  AssemblePackTimeoutError,
} from "../errors.js";
export { type DegradedNeed, type DegradedCapability } from "../common/degradation.js";

// ── the exec phase products ─────────────────────────────────────────────────────────────
export {
  parseProgram,
  validateAgainstAmbient,
  validateAgainstResolution,
  classifyProgram,
  classifierFromAmbient,
  type ParsedProgram,
  type AssembledAmbient,
  type ExecInstance,
  type SymbolDescription,
} from "../eval/exec-phases.js";
export { assembleAmbient, type AssembleAmbientOptions } from "../eval/generator-exec.js";

// ── Stage B — the Vocabulary artifact + assembleRun (docs/plans/stage-b-runcontext-absorbs-
// assembly.md) — `exec(code, { capabilities, config })`'s DEFAULT resolution path (Stage B3).
// Exported here so a caller wanting the `assembleAmbient`-style "assemble once, reuse across N
// calls" idiom on this path can rely on the tuple memo directly instead of holding an
// `AssembledAmbient` handle: `buildVocabulary` is memoized by (capability-set identity, config
// identity), so calling it (or `exec`/`assembleRun`) repeatedly with the SAME capabilities/config
// objects is a cache hit, not a rebuild — the "warm reuse" a caller like arrival-mcp's
// `DiscoveryTool` gets from `assembleAmbient` today, without a disposable handle to manage (the
// artifact is immutable; nothing to dispose). See generator-exec.ts's `execStateViaVocabulary`
// for the production consumer.
export { buildVocabulary, type Vocabulary } from "./vocabulary.js";
export { assembleRun, type AssembleRunOptions } from "./assemble-run.js";

// The read-time metadata resolver rides the same surface (its declaration-side types live
// on `/symbol`) — an ambient consumer resolving a def's bag by hand reaches it here too.
export { resolveMetadata, staticMetadata, type ResolvedMetadata } from "../common/symbols/metadata.js";
