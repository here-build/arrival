/**
 * The differential oracle's core (oracle-harness.md §2/§4.1): does `source.scm`
 * evaluate to the same observable value under the arrival interpreter and under
 * `run(compile(source))`? Implementation-oblivious and execution-only — it never
 * inspects either compiler's internals, and the only view it takes of either
 * world is source-in / JS-face-value-out.
 *
 * Interpreter side: ONE `buildArrivalSession` (the expensive capability-DAG
 * assembly) reused across rows; a FRESH `LexicalScope` per program with
 * `BUILTIN_PREAMBLE` re-executed into it, so program N's defines never leak
 * into program N+1 (spec §4.1, edge §5.6). Mirrors `runProgram`'s own per-form
 * loop (`run-program.ts:461-479`): `execState` per parsed top-level form,
 * thenable-await, `schemeToJs` at the exit.
 *
 * Compiled side — SUBJECT-ROUTED (constitution §9 "the dual-path rule"): the
 * gate subject is `"greenfield"` (default) — the NEW pipeline end to end,
 * classify → extractFacts → walk(overlay registry, sm.idiomAt, sm.prevalueOf) →
 * materializeSharedBindings(sm.sharedBindingsOf) →
 * materializeAsyncness(sm.asyncnessOf) → materializeImports(sm.importsOf) →
 * render, with `RuntimeRef` shims resolved against the stage-0 runtime
 * module (a shim is a legitimate residual; Law F says so). `frame` (a
 * post-render tree scan) DISSOLVED at E1b (engine plan §2 E1b): the import
 * symbol set is now a MODEL VIEW (`sm.importsOf`, unioned over the
 * program's top-level forms) rather than a fresh census over the finished
 * tree — see `../naming/imports.ts`'s header. `async-ify/` (the post-emit
 * `{sync, promise}` rewriting pass) DISSOLVED at E1c (engine plan §2 E1c):
 * asyncness is now ALSO a MODEL VIEW (`sm.asyncnessOf`) plus its mechanical
 * materializer (`materializeAsyncness`, ../naming/asyncness.ts) — see that
 * module's header. `peephole()` (a whole-tree pre-walk rewrite) and
 * `legibility()`'s CSE leg (a post-walk rewrite) both DISSOLVED at E2
 * (engine plan §2 E2, second half): both are now MODEL VIEWS —
 * `sm.idiomAt`, consulted INLINE by `walk()` itself (no separate pre-pass —
 * see `../walker/walk.ts`'s `lowerApp`), and `sm.sharedBindingsOf`, whose
 * mechanical materializer (`materializeSharedBindings`,
 * `../naming/shared-bindings.ts`) runs at the exact pipeline POSITION the
 * dissolved `legibility()` occupied (see that module's header for why: pure-
 * region CSE still needs the finished, already-named tree, and still must
 * run before asyncness materialization — Law W).
 * `"legacy"` keeps the mercury string path callable for A/B — a production bridge, never
 * gate-authoritative. Both subjects export the program's trailing value as
 * `export const __oracleResult = …` (no stdout/JSON round-trip, so `NaN`/`-0`
 * survive), write a scratch `.mts` INSIDE this package tree (Node
 * bare-specifier resolution walks up for `node_modules`; `os.tmpdir()` never
 * finds the workspace), and execute in-process through ONE shared tsx loader
 * registration guarded against pipeline hangs (see `importCaseModule`).
 *
 * Greenfield registry (`greenfieldRegistryFor`, below): `withRules(merged,
 * phase1Rules)`, where `merged` is the ambient's own harvest
 * (`emitRegistryOf(session.ambient)`) with `scheme/srfi-1`'s STATIC harvest
 * (`emitRegistryOf([srfi1])`, never assembled live — see `greenfieldRegistryFor`'s
 * own note for why) filled in underneath — harvested ONCE per session ambient and
 * cached (the harvest itself memoizes per capability instance, but the Law-N
 * witness sweep and row-map build are per-call; one registry per session is the
 * §4.1 reuse contract applied here).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { execState, LexicalScope, parseGenerator, schemeToJsUntyped } from "@here.build/arrival";
import type { AssembledAmbient } from "@here.build/arrival/env";
import { srfi1 } from "@here.build/arrival/srfi";
import { buildArrivalSession, BUILTIN_PREAMBLE, type InferFn } from "@inhuman.tools/arrival-run";
import { DEFAULT_STRATEGY, projectToJsRaw, type Strategy } from "@inhuman.tools/mercury";
import { register } from "tsx/esm/api";

import type { ClassifyResult } from "../coreform/types.js";
import { SchemeSemanticModel } from "../model/model.js";
import { materializeAsyncness, materializeImports, materializeSharedBindings } from "../naming/index.js";
import { emitRegistryOf, type EmitRegistry } from "../registry/index.js";
import { render } from "../residual/render.js";
import type { CompilationUnit } from "../residual/types.js";
import { inferAsyncSeeds, phase1Rules, withRules, type OverlayEmitRegistry } from "../rules/index.js";
import { walk } from "../walker/index.js";
import { classifyCompiledError, classifyInterpreterError, type ErrorClass } from "./error-classifier.js";

/** The expensive, reusable half of a differential run — one capability-DAG
 *  assembly, held across many corpus/fuzz iterations (spec §4.1). */
export interface OracleSession extends AsyncDisposable {
  readonly ambient: AssembledAmbient;
  dispose(): Promise<void>;
}

/**
 * Build the one shared interpreter session. No `loader` is passed — every
 * corpus/fuzz program is a self-contained snippet, so `(require …)` stays an
 * unbound symbol by capability withholding. `infer` is the required non-thunk
 * `InferFn` callback (`BuildArrivalEnvOpts.infer`); the stub keeps `(infer …)`
 * a BOUND symbol that fails loudly, never an "unbound variable" red herring.
 *
 * srfi-1 is deliberately NOT added to `capabilities` here — see
 * `greenfieldRegistryFor`'s own note for the ambient-gap fix and why it lives at the
 * HARVEST layer instead of here (a real `AssembleLinearizationError`, not just a style
 * choice).
 */
export async function openOracleSession(): Promise<OracleSession> {
  const infer: InferFn = () => {
    throw new Error("oracle: (infer …) not supported outside the async-family cell");
  };
  const session = await buildArrivalSession({ name: "arrival-mercury-oracle", infer, params: {} });
  const dispose = (): Promise<void> => session.dispose();
  return { ambient: session.ambient, dispose, [Symbol.asyncDispose]: dispose };
}

export type Outcome =
  | { kind: "value"; value: unknown } // membrane JS face, both sides
  | { kind: "throw"; errorClass: ErrorClass; message: string; raw: unknown };

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v != null && typeof (v as { then?: unknown }).then === "function";

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

let scopeCounter = 0;

/** Evaluate `source` in the shared session under a fresh scope; the value is the
 *  interpreter's membrane JS face (`schemeToJs`, the same exit `runProgram` takes). */
export async function evalInterpreter(session: OracleSession, source: string): Promise<Outcome> {
  try {
    const scope = LexicalScope.fresh(`oracle-${scopeCounter++}`);
    await execState(BUILTIN_PREAMBLE, { ambient: session.ambient, scope });
    const forms = await parseGenerator(source);
    let last: unknown;
    for (const form of forms) {
      const state = await execState(form, { ambient: session.ambient, scope });
      last = state.values.at(-1);
      if (isThenable(last)) last = await last; // the evaluator can hand back an unforced Promise
    }
    return { kind: "value", value: schemeToJsUntyped(last, {}) };
  } catch (e) {
    return { kind: "throw", errorClass: classifyInterpreterError(e), message: messageOf(e), raw: e };
  }
}

/**
 * R7RS `(error …)` support for the LEGACY artifact world only: mercury lowers
 * `(error …)` to a bare `error(…)` call with no runtime behind it, so the
 * legacy path supplies the deterministic throwing shim (the "user-error"
 * ErrorClass's compiled half). The greenfield path never sees this preamble —
 * its `error` is a real stage-0 runtime import (`SchemeUserError`).
 * Function declaration ⇒ hoisted, callable from any emitted position; a corpus
 * program that (pathologically) defines its own `error` collides loudly with a
 * SyntaxError instead of silently shadowing the probe.
 */
const COMPILED_PREAMBLE = `// ── oracle harness preamble (arrival-mercury, generated — never committed) ──
class __OracleUserError extends Error {
  readonly irritants: readonly unknown[];
  constructor(message: unknown, irritants: readonly unknown[]) {
    super(String(message));
    this.name = "OracleUserError";
    this.irritants = irritants;
  }
}
function error(message: unknown, ...irritants: unknown[]): never {
  throw new __OracleUserError(message, irritants);
}
`;

/** Corpus-authoring misuse (no trailing expression to observe, unparseable wrap)
 *  escapes `evalCompiled` as a REAL throw, never an Outcome — the same contract
 *  `exportTrailingResult` has always had, made nominal so the greenfield path's
 *  compile-door catch can re-throw it. */
class OracleAuthoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OracleAuthoringError";
  }
}

/**
 * LEGACY-path trailing-result surgery: rewrite the compiled module's LAST
 * top-level chunk (raw `assemble` output joins forms with `\n\n`; a single
 * lowered form never contains a blank line) into
 * `export const __oracleResult = <expr>;` — the exporting twin of
 * `compile-project.ts::printEntryResult`. Throws a plain harness error (never
 * an Outcome) when the program has no trailing EXPRESSION to observe: that is
 * corpus-authoring misuse, not a semantics divergence.
 */
function exportTrailingResult(compiled: string): string {
  const cut = compiled.lastIndexOf("\n\n");
  const head = cut === -1 ? "" : compiled.slice(0, cut);
  const tail = (cut === -1 ? compiled : compiled.slice(cut + 2)).trim();
  if (tail === "") {
    throw new OracleAuthoringError("oracle evalCompiled: empty compiled output — no trailing expression to observe");
  }
  if (/^(const|let|var|function|class|import|export|type|interface|enum|declare)\b/.test(tail)) {
    throw new OracleAuthoringError(
      `oracle evalCompiled: the program's last top-level form must be an expression (the value under test), got a statement: ${tail.slice(0, 80)}`,
    );
  }
  const expr = tail.replace(/;$/, "");
  return `${head === "" ? "" : `${head}\n\n`}export const __oracleResult = ${expr};\n`;
}

const SCRATCH_ROOT = fileURLToPath(new URL("../../.oracle-tmp/", import.meta.url));
/**
 * Scratch subdir unique PER MODULE INSTANCE, not per process: vitest reuses a
 * forked worker across test files with a fresh module registry each time, so a
 * pid+counter filename repeats within one process while tsx's loader cache is
 * per-PROCESS — a repeated path would serve test-file A's cached module as
 * test-file B's result (observed as a corpus-vs-smoke value flake). The random
 * component makes every URL this instance ever imports globally fresh.
 */
const INSTANCE_TAG = `${process.pid}-${randomBytes(6).toString("hex")}`;
const SCRATCH_DIR = path.join(SCRATCH_ROOT, `run-${INSTANCE_TAG}`);
let scratchCounter = 0;

/**
 * ONE namespaced tsx registration, reused for every case import this module
 * instance performs. `tsImport()` was the previous mechanism and is a trap at
 * corpus scale: each call registers a FRESH namespaced loader (its own esbuild
 * transform pipeline) and never unregisters (verified against tsx 4.22.4's
 * api impl — `register({namespace: Date.now()})` per call, no cleanup), so a
 * 34-row corpus run piles up dozens of loader pipelines per worker; under
 * fleet concurrency an import eventually hangs FOREVER on a stalled pipeline —
 * observed twice on different rows, both unkillable by vitest's timeout (the
 * hang sits under an await the timer can't preempt). One registration = one
 * pipeline; the namespace tag (module-instance-unique, like the scratch dir)
 * keeps it out of vitest's own loader chain and out of sibling instances'.
 */
const caseLoader = register({ namespace: `arrival-mercury-oracle-${INSTANCE_TAG}` });

/** How long a single case-module import may take before the harness declares
 *  the LOADER (not the case) faulty. Real imports of these tiny emitted
 *  modules complete in well under a second; 60s is pure headroom. */
const IMPORT_TIMEOUT_MS = 60_000;

/** Oracle INFRASTRUCTURE failure — a stuck loader pipeline, never a semantics
 *  verdict. Thrown out of `evalCompiled` (the `OracleAuthoringError` path), so
 *  a hang can never false-classify as a compiled-side crash Outcome. */
export class OracleImportHangError extends Error {
  constructor(file: string) {
    super(
      `oracle evalCompiled: importing the compiled case module hung twice (> ${IMPORT_TIMEOUT_MS}ms each) — ` +
        `loader-pipeline fault, not a program verdict. Module kept for inspection at ${file}`,
    );
    this.name = "OracleImportHangError";
  }
}

/** Import a case module through the shared registration, guarded against the
 *  hang mode: race a generous timer, retry ONCE at a fresh path (a fresh URL
 *  cannot hit any wedged in-flight resolution), then fail loudly. */
async function importCaseModule(file: string): Promise<{ default?: unknown }> {
  const attempt = async (p: string): Promise<{ default?: unknown } | typeof HUNG> => {
    let timer: NodeJS.Timeout | undefined;
    const hangSignal = new Promise<typeof HUNG>((resolve) => {
      timer = setTimeout(() => resolve(HUNG), IMPORT_TIMEOUT_MS);
    });
    const imported = caseLoader.import(pathToFileURL(p).href, import.meta.url) as Promise<{
      default?: unknown;
    }>;
    try {
      return await Promise.race([imported, hangSignal]);
    } finally {
      clearTimeout(timer);
      // A raced-out import that REJECTS later must not surface as an unhandled
      // rejection (it would crash the vitest worker long after the row moved on).
      void imported.catch(() => undefined);
    }
  };
  const first = await attempt(file);
  if (first !== HUNG) return first;
  const retryFile = file.replace(/\.mts$/, ".r2.mts");
  writeFileSync(retryFile, readFileSync(file, "utf8"), "utf8");
  const second = await attempt(retryFile);
  if (second !== HUNG) return second;
  throw new OracleImportHangError(file);
}
const HUNG = Symbol("import-hung");

/** Best-effort scratch cleanup — not load-bearing (the directory is gitignored
 *  and outside tsconfig's `src/**` include), but a clean run leaves no litter.
 *  Removes only THIS instance's subdir: sibling vitest workers may still be
 *  mid write→import in their own subdirs (a whole-root rm mid-run is the
 *  ENOENT flake this layout exists to prevent). The root rmdir is non-recursive
 *  on purpose — it only succeeds for whoever cleans last. */
export function cleanupOracleScratch(): void {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
  try {
    rmdirSync(SCRATCH_ROOT);
  } catch {
    /* not empty or absent — another worker's litter is not ours to sweep */
  }
}

// ─── the greenfield subject (constitution §9 subject-routing) ─────────────────────────

/** The per-session compiled-side registry: harvest + Phase-1 overlay + the Law-N
 *  witness sweep, once per ambient (§4.1's reuse contract applied to the compiler
 *  side). Keyed by the AMBIENT (not the session wrapper) so two OracleSession
 *  handles over one assembly share the work. (`narrowsMembers` used to be cached
 *  alongside the registry here; E0's rewiring moved that derivation onto
 *  `SchemeSemanticModel.narrowsMembers` — a cheap, per-model O(names) pass over
 *  the SAME registry, so caching it a second time here would only be a
 *  redundant memo of the same cheap computation, model.ts's own header.) */
const registryCache = new WeakMap<AssembledAmbient, OverlayEmitRegistry>();

/**
 * THE AMBIENT-GAP FIX (rules/phase1.ts's own relocation note; R1's flagged
 * follow-up): `scheme/srfi-1` cannot simply be ADDED to `openOracleSession`'s live
 * `capabilities` — verified directly, not assumed. `srfi1`'s own `deps`
 * (foundations/arrival/arrival/src/env/srfi/srfi-1.ts: `[equality, numeric,
 * exceptions, vectors, lists]`, `lists` LAST) and `arrival/schema`'s own `deps`
 * (.../env/schema.ts: `[lists, equality, strings, numeric, exceptions]`, `lists`
 * FIRST) disagree about the relative order of `lists` vs `equality` — and
 * `arrival/schema` is unconditionally rooted in `arrivalCapabilities()`, hence always
 * present in `session.ambient.capabilities`. Assembling both roots in one
 * `assembleEnv` call throws `AssembleLinearizationError` (confirmed empirically:
 * `openOracleSession` with `capabilities: [srfi1]` fails at session build, every
 * time). Reordering srfi-1.ts's `deps` to match schema.ts's would only trade one
 * conflict for another — its own comment documents `vectors` must precede `lists`
 * to satisfy `polyglot-clojure.ts`'s independent precedence, a constraint that's
 * ACTUALLY exercised (BASE_PACKS assembles both today).
 *
 * So srfi-1 is harvested STATICALLY instead — off the bare `EnvCapability`, never
 * assembled live — via `emitRegistryOf`'s OTHER documented input mode (harvest.ts:
 * "or from a bare capability tree"), which walks the capability/deps GRAPH directly
 * (a plain deps-first DFS, harvest.ts's own `visit`) with no C3 linearization and
 * therefore no ordering conflict to trip over. Every capability in srfi-1's own dep
 * closure (equality/numeric/exceptions/vectors/lists) declares its `symbols` as a
 * plain object, never a builder function (verified: none of the five branches on
 * `configuration`/`resources`), so the phantom/dry activation this bare-list path
 * falls back to is BYTE-IDENTICAL to any "real" assembled activation's answer for
 * all of them — there is no activation-dependent branch anywhere in this closure to
 * diverge on. Computed once, module scope: `emitRegistryOf` takes no session/ambient
 * input here, so there is nothing to key a per-session cache on.
 *
 * Behaviorally inert for everything this package already relied on: `scheme/lists`
 * &c. still resolve through the REAL ambient (below, ambient-first precedence), byte
 * -identical to before. This purely ADDS the names the ambient gap left dark —
 * filter/take/drop/iota/zip/every/any/… — which is exactly (and only) what closes
 * filter's ambient gap (rules/phase1.ts's now-deleted table row).
 */
const srfi1Registry = emitRegistryOf([srfi1]);

/** Exported so tests can probe the REAL compiled-side registry directly instead of
 *  re-deriving the ambient+srfi-1 merge inline — a prior inline re-derivation
 *  (cross-pass-fixtures.test.ts) silently fell out of step the moment this function
 *  grew the srfi-1 merge below; see that test's own note. Current external callers:
 *  rule-lint.test.ts's EmitCtx-surface sweep over the fully-relocated Contract rules
 *  (filter included, now that its ambient gap is closed) and
 *  cross-pass-fixtures.test.ts's per-row compile. `compileGreenfield` below is the
 *  internal caller — same registry, same cache, no divergence possible between what
 *  a test inspects and what the pipeline actually compiles against. */
export function greenfieldRegistryFor(session: OracleSession): OverlayEmitRegistry {
  let hit = registryCache.get(session.ambient);
  if (hit === undefined) {
    const ambientRegistry = emitRegistryOf(session.ambient);
    // Ambient rows win on any name they carry (the real, C3-consistent assembly);
    // srfi-1's static harvest only fills in names the ambient never reaches. In
    // practice these sets are disjoint on everything but srfi-1's OWN deps
    // (lists/equality/numeric/exceptions/vectors), which the ambient already
    // resolves via arrival/schema — so this fallback fires only for genuinely
    // srfi-1-only symbols.
    const withSrfi1: EmitRegistry = {
      lookup: (name) => ambientRegistry.lookup(name) ?? srfi1Registry.lookup(name),
      names: new Set([...ambientRegistry.names, ...srfi1Registry.names]),
    };
    hit = withRules(withSrfi1, phase1Rules);
    registryCache.set(session.ambient, hit);
  }
  return hit;
}

const ORACLE_MAIN = "__oracle-main";

/**
 * Make the wrap's `(define (__oracle-main) …)` the module's DEFAULT EXPORT and drop the
 * trailing `(__oracle-main)` call — the emitted artifact is a program-face MODULE
 * (`export default function OracleMain(){…}`), never an inline execution or an eager value
 * (reference-program-face-always-function; R-G1). The loader (`evalCompiled`) CALLS
 * `ns.default()` to observe the program's value, so the value/function boundary lives at the
 * consumer, not baked into the artifact — stable across a future pure→dynamic rework.
 */
function exportUnitResult(unit: CompilationUnit): CompilationUnit {
  const body = [...unit.body];
  const last = body.pop();
  if (last === undefined) {
    throw new OracleAuthoringError("oracle evalCompiled: wrapped unit has no trailing call — internal wrap invariant broken");
  }
  // The wrap yields exactly one top-level FnDecl (the `__oracle-main` body); mark it the
  // default export. `last` (the trailing call) is discarded — no inline execution.
  const decls = unit.decls.map((d) => (d.t === "FnDecl" ? { ...d, exported: "default" as const } : d));
  return { decls, body };
}

/**
 * The greenfield pipeline, source → module text:
 *
 *   wrap → classify → extractFacts → walk(sm.idiomAt, sm.prevalueOf) → exportResult
 *     → materializeSharedBindings(sm.sharedBindingsOf)
 *     → materializeAsyncness(sm.asyncnessOf) → materializeImports(sm.importsOf) → render
 *
 * IDIOMS (constitution §3.1/§3.5, Law C — `sm.idiomAt`, engine plan §2 E2)
 * are consulted DURING `walk()` itself (`../walker/walk.ts`'s `lowerApp`,
 * before any other rung of its §4.2 dispatch ladder) — AFTER the type
 * pass/TypeFacts extraction, matching the constitution's own ordering
 * (§3.1's diagram: the two analysis branches sit ABOVE the idiom layer,
 * which sits ABOVE the emit pass). Concretely, this still means:
 *   - extractFacts sees the ORIGINAL `car`/`infer` nodes — both real,
 *     type-annotated registry symbols the type-lens's ambient prelude
 *     already knows about. `sm.idiomAt`'s decisions are never fed to
 *     extractFacts at all now (there is no separate pre-rewritten tree to
 *     feed it) — a strictly SIMPLER invariant than the dissolved
 *     `peephole()` pass needed to maintain by ordering alone.
 *   - the handful of nodes `idiomAt` mints (scalar-fold's fused App) or
 *     trims (cache-key-elide's shortened arg list) simply have no entry in
 *     `extraction.facts` — Law F's "absence of a fact ⇒ the conservative
 *     residual" already covers this; no rule in `phase1Rules` reads facts on
 *     an infer-family node, so today this is a non-issue in practice, not
 *     just in theory.
 *
 * STATIC PREVALUATION (gate3-human-grade-rulings.md's R-G6; `sm.prevalueOf`,
 * `../prevalue/index.ts`) is consulted the SAME way, at the same layer: the
 * top of every `If`/`And`/`Or` `walk()` lowers. A provably-constant
 * guard/operand (Scheme truthiness) folds to whichever branch is live,
 * dropping the other whole — including any `prohibited-dynamics` door
 * inside it, which is simply never visited. No separate fold pre-pass
 * exists; `extractFacts` sees the ORIGINAL, un-folded `If`/`And`/`Or` nodes
 * for the same reason idioms don't feed it either.
 *
 * SHARED BINDINGS (constitution §3.5's third invention, leg 3 — pure-region
 * CSE; `sm.sharedBindingsOf` + `materializeSharedBindings`, engine plan §2
 * E2) runs on the finished Residual tree, BEFORE the asyncness materializer
 * — a documented DEVIATION from the constitution's §3.1 diagram and §3.5
 * table, which both draw it after. See `../naming/shared-bindings.ts`'s
 * header for the full reasoning; the short version: CSE hoists duplicate
 * `Call`s into an ordinary sync-shaped `Const` BEFORE asyncness exists, so
 * `materializeAsyncness`'s ordinary Const-handling (await the init iff
 * seeded; every `Ref` read is unconditionally sync) awaits the ONE hoisted
 * call correctly with zero changes to either pass. Running it after
 * asyncness materialization would force it to see through `Await` nodes — a
 * Promise-aware code path Law W (rules/walker output is async-BLIND) has no
 * other reason to introduce. (E1c, engine plan §2 E1c, carried this
 * constraint forward unchanged from the dissolved `async-ify/` pass onto
 * its replacement — see ../naming/asyncness.ts's header and
 * ../naming/imports.ts's header for the full account of what survived and
 * what didn't.)
 *
 * THE WRAP: the whole program compiles as one `(define (__oracle-main) …)` body
 * plus a trailing `(__oracle-main)` call. The walker's top level discards
 * non-define statement values (`lowerStmts`) — correct for real programs, but the
 * oracle must OBSERVE the trailing form's value; a function body's tail position
 * preserves it (`bodySeq(…, "tail")`), and body-position defines pre-register
 * exactly like top-level ones (letrec* both), so wrapping is semantics-neutral
 * for every self-contained corpus program. The interpreter side stays unwrapped —
 * it evaluates form-by-form and reads the last form's value directly.
 *
 * Facts run on the WRAPPED source (spans are wrap-relative on both sides of the
 * extraction, so the join is unaffected). The registry's narrows rows feed the
 * NForm grammar via `narrowsMembersOf` — the overlay's `null?`/`pair?` emit bare
 * and flow into `facts.boolean` exactly as Contract-carried rows would.
 *
 * Exported (beyond `evalCompiled`'s own use) for the §8 determinism check and the
 * §9 enforcement-spine `tsc --strict` output gate — both need the exact bytes the
 * gate subject produces, not a reconstruction of the pipeline.
 *
 * E0 rewiring (engine plan §2 E0): classify, facts, and the registry now flow
 * through a `SchemeSemanticModel` instead of being assembled inline —
 * `sm.coreform` / `sm.factsMap()` / `sm.registry` replace the bare
 * `classify(desugar(parseSexprs(...)))` / `extractFacts(...)` calls this
 * function used to make directly. The passes downstream of classification
 * (`walk`, `render`) are UNCHANGED — they still read a plain
 * `ClassifyResult`/registry/facts-map, exactly as before; only WHERE those
 * values come from moved. (`asyncIfy`/`peephole`/`legibility` were on this
 * same unchanged-list at E0's writing; E1c and E2 below are what changed
 * them.)
 *
 * E1b cut-over (engine plan §2 E1b): `frame` (a post-render `RuntimeRef`
 * census + ad hoc collision-avoidance ladder) DISSOLVED. The import symbol
 * set below is `sm.importsOf`, unioned over `sm.coreform`'s own top-level
 * forms — a MODEL VIEW, not a fresh tree scan — and `../naming/imports.ts`'s
 * `materializeImports` commits it (prepend the `Import` decl, rewrite every
 * `RuntimeRef` to a `Ref`) at the same pipeline POSITION `frame` occupied
 * (still after the asyncness materializer — see that module's header for
 * why, and E1c's own note below for how that survived asyncIfy's
 * dissolution). No fixture bytes should move by construction —
 * `model-imports-agree.test.ts` pins `sm.importsOf`'s answer against the
 * actual emitted imports, idiom folds included.
 *
 * E1c cut-over (engine plan §2 E1c): `async-ify/` (a post-emit `{sync,
 * promise}` rewriting pass over the finished Residual tree) DISSOLVED.
 * Asyncness is now `sm.asyncnessOf` (the call-graph fixpoint, confined
 * inside one model view — ../naming/asyncness.ts's `asyncnessOf`, which
 * `SchemeSemanticModel` wraps verbatim) plus `materializeAsyncness` (the
 * mechanical Await-minting/`.async`-setting rewrite, same module) at the
 * exact pipeline POSITION `asyncIfy` occupied — after the shared-bindings
 * materializer, before `materializeImports` (see that module's header: the
 * position survives because `materializeAsyncness`'s own seed detection
 * keys off `RuntimeRef` symbol names exactly like the dissolved pass did).
 * Seeded from the SAME `inferAsyncSeeds` (rules/phase1.ts) the dissolved
 * pass read — porting the seeding, not re-deriving it. No fixture bytes
 * should move: same fixpoint, same rewrite table, different home.
 *
 * E2 cut-over (engine plan §2 E2, second half): `peephole()` (a whole-tree
 * pre-walk rewrite, `../peepholes/`) and `legibility()`'s CSE leg (a
 * post-walk rewrite, the dissolved `../legibility/legibility.ts` +
 * `../legibility/cse.ts`) both DISSOLVED. Idioms are now `sm.idiomAt`, a
 * per-`App` decision `walk()` consults INLINE (no separate tree pass at
 * all — the `WalkOptions.idiomAt` callback below); shared bindings are now
 * `sm.sharedBindingsOf` (the decision) + `materializeSharedBindings` (the
 * mechanical commit, `../naming/shared-bindings.ts`), at the exact pipeline
 * POSITION `legibility()` occupied. Because idiom folding happens INSIDE
 * `walk()` now, `sm.importsOf`'s own synthetic walk (model.ts's
 * `computeImportsOf`) sees it too — the union below reads `sm.coreform`'s
 * ORIGINAL forms directly; the caller-side "query over the peepholed forms"
 * rule `model-imports-agree.test.ts` used to pin is gone WITH the pass (see
 * that test's own updated row, and model.ts's `importsOf` doc). No fixture
 * bytes should move: same decisions (idiom fold, CSE hoist), new home.
 *
 * E3 cut-over (engine plan §2 E3): TWO more decisions relocate off the
 * walker's own inline branching, onto `../lowering/index.ts`
 * (`sm.loweringDecisionAt`/`sm.guardFormOf`, `WalkOptions.loweringDecisionAt`/
 * `guardFormOf` below) — the §4.2 rule/shim/door ladder and Law T's guard
 * form no longer read `registry.lookup`/`facts.get` inline inside `walk()`
 * itself (the S5-extended lint's own mechanical check,
 * model-imports-agree.test.ts). No fixture bytes should move: same
 * decisions, same registry/facts inputs, relocated. THE SHAKE
 * (`../shake/index.ts`'s `shakeTopLevel`, `sm.shakeOf`) is new behavior, not
 * a relocation: dead-and-pure top-level defines are pruned from the oracle
 * wrapper's OWN body (`main.body`, below — where a corpus program's real
 * top-level defines live once wrapped) before `walk()` ever sees them;
 * effectful crossings (an unreferenced top-level `infer`, say) survive on
 * effect grounds. Fixture bytes MAY move here — a dropped dead-define's
 * lines are the wanted shake class (engine plan §2 E3; REBASE_LOG-recorded
 * per program).
 */
export function compileGreenfield(session: OracleSession, source: string): string {
  const registry = greenfieldRegistryFor(session);
  const wrapped = `(define (${ORACLE_MAIN})\n${source}\n)\n(${ORACLE_MAIN})\n`;
  const sm = new SchemeSemanticModel(wrapped, registry);
  const classified = sm.coreform;
  const main = classified.forms[0];
  if (main?.kind !== "DefineFn") {
    throw new OracleAuthoringError(
      "oracle evalCompiled: the greenfield wrap did not classify as a definition — empty or unparseable program",
    );
  }
  const lastForm = main.body.at(-1);
  if (lastForm === undefined) {
    throw new OracleAuthoringError("oracle evalCompiled: empty program — no trailing expression to observe");
  }
  if (lastForm.kind === "Define" || lastForm.kind === "DefineFn") {
    throw new OracleAuthoringError(
      "oracle evalCompiled: the program's last top-level form must be an expression (the value under test), got a definition",
    );
  }
  // E3's shake (engine plan §2 E3; ../shake/index.ts's `shakeTopLevel`,
  // `sm.shakeOf`) — dead-and-pure top-level defines pruned BEFORE `walk()`
  // ever sees them (effectful crossings survive; requires untouched — see
  // that module's own header). Applied to `main.body`, NOT `classified.forms`
  // directly: the oracle wrap puts a corpus program's own top-level defines
  // one level INSIDE `(define (__oracle-main) …)`, so that is where sibling
  // liveness must be computed (classified.forms itself is just [the wrapper,
  // its trailing call] — no dead siblings ever live at THAT level). The
  // trailing form under test is NEVER a candidate (it is always a "root" —
  // never itself a named define — so `lastForm`, validated above, survives
  // identically whether the shake fires or not).
  const shaken = sm.shakeOf(main.body);
  const shakenMain = { ...main, body: shaken.forms };
  const shakenClassified: ClassifyResult = { ...classified, forms: [shakenMain, ...classified.forms.slice(1)] };
  // idiomAt: this.idiomAt — the E2 decision-view, consulted INLINE by
  // lowerApp; no separate peephole() pre-pass exists anymore.
  // prevalueOf: this.prevalueOf — R-G6's static-prevaluation decision-view
  // (gate3-human-grade-rulings.md), consulted INLINE by every If/And/Or this
  // walker lowers; no separate fold pre-pass, same discipline as idiomAt.
  const sync = walk(shakenClassified, {
    registry: sm.registry,
    facts: sm.factsMap(),
    idiomAt: sm.idiomAt,
    prevalueOf: sm.prevalueOf,
    // propagationOf: this.propagationOf — the structural-optimization
    // lane's constant/copy propagation (gate3-human-grade-rulings.md's
    // governing principle; `../propagate/index.ts`), consulted INLINE by
    // `letStmts` BEFORE prevaluation examines a nested If/And/Or — no
    // separate propagation pre-pass, same discipline as idiomAt/prevalueOf.
    // sameBranchOf: this.sameBranchOf — the same lane's other free fold
    // (`(if c A A)` when `cond` isn't provably constant but both arms are
    // the same trivially-pure value anyway), consulted right after
    // prevalueOf declines, at the same two call sites.
    propagationOf: sm.propagationOf,
    sameBranchOf: sm.sameBranchOf,
    // loweringDecisionAt / guardFormOf: E3's remaining two decision-views
    // (engine plan §2 E3; ../lowering/index.ts) — the §4.2 ladder and Law-T's
    // guard form, both consulted INLINE by the walker instead of a direct
    // `registry.lookup`/`facts.get` read (the S5-extended lint's own check,
    // model-imports-agree.test.ts). Wired here at walk()'s TOP level too
    // (harmless no-op for the oracle wrap's own [wrapper, trailing-call]
    // pair) for the day a real, unwrapped top level exists (E4).
    loweringDecisionAt: sm.loweringDecisionAt,
    guardFormOf: sm.guardFormOf,
    shakeOf: sm.shakeOf,
    register: "run",
  });
  // THE MODEL VIEW, not a post-walk rewriting pass (engine plan §2 E2) —
  // the SAME eligibility/structural-equality decision the dissolved
  // `legibility/cse.ts` computed, confined inside `sm.sharedBindingsOf`;
  // `materializeSharedBindings` is the mechanical commit (splice, substitute,
  // then real-allocate the hoisted names).
  const shared = materializeSharedBindings(sm.sharedBindingsOf(exportUnitResult(sync)));
  // THE MODEL VIEW, not a post-emit rewriting pass (engine plan §2 E1c) —
  // the SAME call-graph fixpoint the dissolved `async-ify/` pass ran,
  // confined inside `sm.asyncnessOf`; `materializeAsyncness` is the pure,
  // mechanical reader that mints Await/sets `.async` from those facts.
  const asyncified = materializeAsyncness(sm.asyncnessOf(shared, inferAsyncSeeds));
  // THE MODEL VIEW, not a post-render scan (engine plan §2 E1b) — every
  // top-level form's own recursive `sm.importsOf`, unioned into the
  // whole-program symbol set `materializeImports` needs. Queried over the
  // SHAKEN forms (not `classified.forms` directly) — a pruned-away dead
  // define's own import needs must not superfluously survive into the
  // materialized import list. `sm.idiomAt` folding happens INSIDE `walk()`
  // (and inside `importsOf`'s own synthetic walk, model.ts's
  // `computeImportsOf`), so the two can never disagree about which symbols a
  // folded call needs (see importsOf's own doc, model.ts).
  const importSymbols = new Set<string>();
  for (const form of shakenClassified.forms) for (const s of sm.importsOf(form)) importSymbols.add(s);
  const materialized = materializeImports(asyncified, { symbols: importSymbols, runtimeModule: `./${STAGE0_BASENAME}` });
  return render(materialized);
}

// ── staging the runtime module next to the scratch cases ──
// tsx resolves relative `.mts` specifiers natively, and a sibling file keeps the
// scratch project self-contained (the "copy" half of the spec's copy-or-import-map
// choice — an absolute import-map would pin scratch output to this checkout's
// layout). Copied once per module instance; `.ts` source first, `.js` (dist) as
// the built-package fallback — plain JS is valid `.mts` content.
const STAGE0_BASENAME = "stage0.mts";
let stage0Staged = false;

function stageRuntimeModule(): void {
  if (stage0Staged) return;
  const candidates = [new URL("../runtime/stage0.ts", import.meta.url), new URL("../runtime/stage0.js", import.meta.url)];
  let source: string | undefined;
  for (const url of candidates) {
    try {
      source = readFileSync(url, "utf8");
      break;
    } catch {
      /* try the next candidate */
    }
  }
  if (source === undefined) {
    throw new Error(`oracle evalCompiled: stage-0 runtime module not found beside ${import.meta.url}`);
  }
  mkdirSync(SCRATCH_DIR, { recursive: true });
  writeFileSync(path.join(SCRATCH_DIR, STAGE0_BASENAME), source, "utf8");
  stage0Staged = true;
}

/** `"greenfield"` — the new pipeline, gate-authoritative from Phase 1 (§9);
 *  `"legacy"` — the mercury string path, kept callable for A/B only. */
export type OracleSubject = "greenfield" | "legacy";

export interface EvalCompiledOptions {
  /** Default `"greenfield"` — the dual-path rule's gate subject. */
  readonly subject?: OracleSubject;
  /** Legacy-path strategy knob; ignored by the greenfield subject. */
  readonly strategy?: Strategy;
}

/**
 * Compile `source` under the routed subject and execute the artifact in-process.
 * Compile-time doors (walker `WalkDoorError`, `MaterializeImportsDoorError`, ASYNC-IFY doors,
 * parse failures, mercury's own doors) surface as classified throw-Outcomes — the
 * same path "unsupported-form" uses (spec §2). Corpus-authoring misuse
 * (`OracleAuthoringError`) escapes as a real throw, never an Outcome.
 */
export async function evalCompiled(
  session: OracleSession,
  source: string,
  opts?: EvalCompiledOptions,
): Promise<Outcome> {
  const subject = opts?.subject ?? "greenfield";
  let module: string;
  try {
    if (subject === "legacy") {
      const compiled = projectToJsRaw(source, { target: "run", strategy: opts?.strategy ?? DEFAULT_STRATEGY });
      module = `${COMPILED_PREAMBLE}\n${exportTrailingResult(compiled)}`;
    } else {
      stageRuntimeModule();
      module = compileGreenfield(session, source);
    }
  } catch (e) {
    if (e instanceof OracleAuthoringError) throw e;
    return { kind: "throw", errorClass: classifyCompiledError(e), message: messageOf(e), raw: e };
  }
  mkdirSync(SCRATCH_DIR, { recursive: true });
  const file = path.join(SCRATCH_DIR, `case-${process.pid}-${scratchCounter++}.mts`);
  writeFileSync(file, module, "utf8");
  try {
    const ns = await importCaseModule(file);
    // Program face: the default export IS the program; run it to observe the value
    // (reference-program-face-always-function). By construction it is always a function.
    const program = ns.default;
    let value: unknown = typeof program === "function" ? program() : program;
    if (isThenable(value)) value = await value; // symmetric with the interpreter side
    return { kind: "value", value };
  } catch (e) {
    if (e instanceof OracleImportHangError) throw e; // infrastructure, never a verdict
    return { kind: "throw", errorClass: classifyCompiledError(e), message: messageOf(e), raw: e };
  }
}

const bigintEqualsNumber = (big: bigint, num: unknown): boolean =>
  typeof num === "number" && Number.isInteger(num) && BigInt(num) === big;

function isPlainObjectLike(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  // Dict faces are plain objects (or null-proto). A Date/RegExp/class instance
  // must NOT compare as an (often empty) key-set — that greened `new Date(0)`
  // vs `new Date(1)`. Non-plain objects fall through to identity (Object.is).
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function sameKeysDeep(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && oracleEqual(a[k], b[k]));
}

/**
 * Object.is-based equality, recursive over arrays/dicts, proxy-transparent
 * (`Array.isArray` unwraps a Proxy to its target per spec, so egress-proxy
 * results compare structurally). `Object.is` as the scalar default — not `===`
 * — is what makes the `-0`/`NaN` eqv?-sentinel rows and the general numeric
 * path share one function (spec §4.2). The bigint branch is host-only: scheme
 * numeric values never egress as bigint post one-number-rework; it exists
 * solely for an opaque HOST bigint pass-through reaching the comparator.
 */
export function oracleEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "bigint" && typeof b === "bigint") return a === b;
  if (typeof a === "bigint") return bigintEqualsNumber(a, b);
  if (typeof b === "bigint") return bigintEqualsNumber(b, a);
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b); // NaN≡NaN, +0≢−0
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => oracleEqual(x, b[i]));
  if (isPlainObjectLike(a) && isPlainObjectLike(b)) return sameKeysDeep(a, b);
  return Object.is(a, b);
}

/** Render a value for a verdict/failure message — never throws; bigint-safe and
 *  sentinel-faithful (`JSON.stringify` would silently print NaN as `null` and
 *  −0 as `0` — exactly the values the eqv?-sentinel rows exist to distinguish). */
export function show(v: unknown): string {
  if (typeof v === "number" && Number.isNaN(v)) return "NaN";
  if (typeof v === "number" && Object.is(v, -0)) return "-0";
  try {
    return (
      JSON.stringify(v, (_k, x: unknown) =>
        typeof x === "bigint" ? `${x}n`
        : typeof x === "number" && Number.isNaN(x) ? "NaN"
        : typeof x === "number" && Object.is(x, -0) ? "-0"
        : x,
      ) ?? String(v)
    );
  } catch {
    return String(v);
  }
}

export interface OracleVerdict {
  agree: boolean;
  interpreter: Outcome;
  compiled: Outcome;
  detail?: string;
}

/**
 * The agreement law over a pair of outcomes: value≡value via `oracleEqual`,
 * throw≡throw via ErrorClass — never the message (spec §4.2). A both-throw
 * pair that classifies `"other"` is a TAXONOMY GAP and fails loudly rather
 * than counting as agreement — Law F's "never wrong, always visible" stance
 * applied to the oracle's own honesty.
 */
export function agreementOf(interpreter: Outcome, compiled: Outcome): { agree: boolean; detail?: string } {
  if (interpreter.kind === "value" && compiled.kind === "value") {
    return oracleEqual(interpreter.value, compiled.value)
      ? { agree: true }
      : {
          agree: false,
          detail: `value mismatch: interpreter=${show(interpreter.value)} compiled=${show(compiled.value)}`,
        };
  }
  if (interpreter.kind === "throw" && compiled.kind === "throw") {
    if (interpreter.errorClass !== compiled.errorClass) {
      return {
        agree: false,
        detail: `error-class mismatch: interpreter=${interpreter.errorClass} ("${interpreter.message}") compiled=${compiled.errorClass} ("${compiled.message}")`,
      };
    }
    if (interpreter.errorClass === "other") {
      return {
        agree: false,
        detail: `taxonomy gap: both sides threw but classify "other" (interpreter: "${interpreter.message}"; compiled: "${compiled.message}") — extend error-classifier.ts; "other" never counts as agreement`,
      };
    }
    return { agree: true };
  }
  return { agree: false, detail: `outcome-kind mismatch: interpreter=${interpreter.kind} compiled=${compiled.kind}` };
}

/** One differential run: interpreter vs compiled (subject-routed), agreement per
 *  `agreementOf`. */
export async function runOracle(
  session: OracleSession,
  source: string,
  opts?: EvalCompiledOptions,
): Promise<OracleVerdict> {
  const interpreter = await evalInterpreter(session, source);
  const compiled = await evalCompiled(session, source, opts);
  return { ...agreementOf(interpreter, compiled), interpreter, compiled };
}
