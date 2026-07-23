// The `/env` subpath. Two strata share this one home — "environment as an explicit
// product" is what the phase-decomposed exec path is about, so the phase products belong
// on the env subpath alongside the assembly kernel: NOT the root barrel, NOT a new
// `/advanced` subpath.
//
//   • the MID-RUN ASSEMBLY KERNEL (common/kernel.ts) — packs, the runtime assembler (backing
//     `(require/extension :name)`), the assembly errors. STAGE C CUT 4 retired `assembleEnv`/
//     `AssembledEnv` — the BOOTSTRAP half of the kernel (folding an `EnvPack` DAG onto a fresh
//     base) — with zero arrival-internal consumers left: bootstrap assembly is
//     `buildVocabulary`/`assembleRun` now (below), which mints a frozen `Vocabulary` map
//     instead of binding onto a live env. `createRuntimeAssembler` SURVIVES — it applies
//     host-registered `EnvPack`s onto an ALREADY-LIVE env, a genuinely different (mid-run)
//     operation `buildVocabulary` doesn't do.
//   • the EXEC PHASE PRODUCTS — `parseProgram` → `ParsedProgram` (phase 1) and
//     `validateAgainstResolution` (the pure phase-2.5 pass over a sealed resolution
//     chain). STAGE C CUT 3b retired the ambient-phase products
//     (`assembleAmbient`/`AssembledAmbient`/`validateAgainstAmbient`/`classifyProgram`/
//     `classifierFromAmbient`/`ExecInstance`/`SymbolDescription`) along with the ambient
//     path itself — `exec(code, { capabilities, program, scope })` composes what's left
//     on the self-hosted vocabulary path (`buildVocabulary`/`assembleRun`, below).
//
// Everything is re-exported EXPLICITLY (no star) so the public surface of the subpath is
// visible at this barrel — same convention as the package root.

// ── the assembly kernel — the subpath's original face ──
// The barrel imports each symbol from its REAL home, not through a passthrough: the
// assembly machinery from the kernel, the errors from the single error home (errors.ts),
// the degradation types from the degradation domain (common/degradation.ts). This is the
// one place the surface is re-collected; the intermediate modules stay leaf.
export {
  createRuntimeAssembler,
  type EnvPack,
  type PackContext,
  type PreludeBindTarget,
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
export { parseProgram, validateAgainstResolution, type ParsedProgram } from "../eval/exec-phases.js";

// ── Stage B — the Vocabulary artifact + assembleRun (docs/plans/stage-b-runcontext-absorbs-
// assembly.md) — `exec(code, { capabilities, config })`'s ONLY resolution path since Stage C Cut
// 3b retired the ambient path. Exported here so a caller wanting an "assemble once, reuse across
// N calls" idiom can rely on the tuple memo directly: `buildVocabulary` is memoized by
// (capability-set identity, config identity), so calling it (or `exec`/`assembleRun`) repeatedly
// with the SAME capabilities/config objects is a cache hit, not a rebuild — the warm-reuse idiom,
// with no disposable handle to manage (the artifact is immutable; nothing to dispose). See
// generator-exec.ts's `execState` for the production consumer.
export { buildVocabulary, type Vocabulary } from "./vocabulary.js";
export { assembleRun, type AssembleRunOptions } from "./assemble-run.js";

// The read-time metadata resolver rides the same surface (its declaration-side types live
// on `/symbol`) — an ambient consumer resolving a def's bag by hand reaches it here too.
export { resolveMetadata, staticMetadata, type ResolvedMetadata } from "../common/symbols/metadata.js";
