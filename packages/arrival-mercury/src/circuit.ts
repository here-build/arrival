/**
 * `@inhuman.tools/arrival-mercury/circuit` — the BROWSER-SAFE pure surface.
 *
 * The root barrel (`index.ts`) re-exports the oracle harness (`oracle/harness.ts`
 * → `tsx/esm/api`) and the probe witness (`probe/witness.ts` → `node:crypto`) —
 * both Node-only, both browser-poison: importing the root under Vite hard-fails
 * (`createRequire` is not exported by Vite's `__vite-browser-external` stub, from
 * tsx's compiled output), and under jsdom vitest it trips esbuild's TextEncoder
 * invariant. A browser consumer (the studio ELK pane rendering the attribution
 * circuit) needs ONLY the pure front-pipeline + circuit projections, which are
 * transitively free of every node builtin (verified: no `node:*`/`tsx` under
 * `src/front`, `src/coreform`, `src/extract`, `src/model`, `src/verdict`).
 *
 * This subpath is that pure surface — the `env-quasi-packages.md` discipline
 * (subpaths separate surfaces, tree-shake, enforce boundaries). The root barrel
 * stays for Node consumers (mcp-worker's runner, the oracle/probe tests) that
 * genuinely need the harness + witness. Nothing here imports oracle, probe,
 * witness, or seal (seal pulls `probe/verdict`, a Node-adjacent path — a browser
 * renderer never seals; it only draws the static circuit).
 */

// ── the front pipeline: source → classified CoreForm ────────────────────────────
export { parseSexprs } from "./front/parse.js";
export { desugar } from "./front/desugar.js";
export { classify } from "./coreform/index.js";
export type { ClassifyResult, CoreForm, NodeId } from "./coreform/types.js";

// ── extract: CoreForm → StaticProv (the attribution circuit) ────────────────────
export { extractProgram, type ExtractCtx } from "./extract/index.js";
export { defaultRegistry } from "./extract/arm-containers.js";

// ── the four circuit projections (§2f's render consumers + T-compose) ────────────
export { circuitToSexpr } from "./model/circuit-sexpr.js";
export { circuitToMermaid, type MermaidOptions } from "./model/circuit-mermaid.js";
export { toWireframe, type WireframeProjection, type WireframeSideMaps } from "./model/to-wireframe.js";
// The compose projection (provenance-beautiful-child compose-phase.md §4) + the
// C2 census both consumers share (formula `♯k` ≡ sexpr `:id k` by construction).
export { census, type Census } from "./model/census.js";
export {
  type ComposeExpr,
  type ComposeHole,
  type ComposeTemplate,
  type HoleId,
  type HoleReason,
  renderComposeText,
  type SourceLens,
  toComposeTemplate,
} from "./model/compose-template.js";

// ── the verdict channel (pure — for a consumer that wants the static reading) ────
export { channels, circuitVerdict, dataShaped, judgmentShaped, planeOf } from "./verdict/circuit-verdict.js";
export type { CircuitRole, CircuitVerdict, Plane } from "./verdict/circuit-verdict.js";

// ── field-granular access (provenance-beautiful-child, lens 3, Wave 1): a PURE
// subcircuit-valued lens over StaticProv — no probe, no run, no render dependency,
// so it belongs in the browser-safe surface exactly like `channels` above. ──
export { fieldProv, type FieldPath, type FieldProvResult } from "./verdict/field-prov.js";

// ── the StaticProv circuit types ────────────────────────────────────────────────
export type {
  BuildProv,
  ChoiceProv,
  ConstProv,
  FanProv,
  FusedProv,
  HeadRegistry,
  InputProv,
  Integrity,
  MintIntegrity,
  MintProv,
  MuxProv,
  OpaqueProv,
  StaticProv,
  StringProv,
} from "./model/static-prov.js";
export type { CollapseKind } from "./model/static-prov.js";
