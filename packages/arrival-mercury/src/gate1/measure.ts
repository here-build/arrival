/**
 * gate1/measure — the frozen §9 Gate-1 metric (constitution "Gate 1 (type
 * availability — joint with the types track)"), executed against the committed
 * `gate1-corpus` manifest.
 *
 * The metric, verbatim: *site* = each `App(car|cdr|…)` node and each `If`
 * condition's residual decision, register `run`, excluding lens-warned UB sites;
 * *clean* = the idiomatic residual (no `RuntimeRef` shim, no `!== false` guard);
 * *denominator* = all such sites in the manifest corpus. Below the sample-size
 * floor (§9: "too few sites ⇒ extend the corpus, never re-scope on noise"),
 * `runGate1Measurement` throws rather than reporting a noisy percentage.
 *
 * ── Instrument choice (documented per the mission's "choose the cheapest sound
 * approach") ─────────────────────────────────────────────────────────────────
 * `walk()` (../walker/walk.ts) emits NO per-node trace — it returns only the
 * finished `CompilationUnit`, so there is no hook to read decisions off of. Two
 * approaches were open:
 *
 *   (a) run the real pipeline and MATCH residual-tree shapes back to CoreForm
 *       sites through origin spans;
 *   (b) recompute each site's verdict directly from (facts, registry) — the
 *       exact same two inputs `walk()` itself branches on for these two node
 *       kinds — without ever calling `walk()` or touching a `Residual` at all.
 *
 * (b) is cheaper and remains SOUND as a lower bound for these two site classes,
 * but — UPDATED for the E2/E3-era decision views this module does NOT
 * replicate (`idiomAt`/`prevalueOf`/`sameBranchOf`, `../walker/walk.ts`'s
 * `WalkOptions`, all wired live by `compileGreenfield`, ../oracle/harness.ts) —
 * it is no longer the walker's ONLY input for either site class:
 *
 *   - `If`: `walk.ts`'s `truthTest` (via `guardFor`/`guardFormOf`,
 *     `../lowering/index.ts`) is `register === "read" || facts.get(cond.id)
 *     ?.boolean === true` — under the frozen register `"run"`, THIS is exactly
 *     `facts.get(cond.id)?.boolean === true`, which is what this module
 *     recomputes. But `truthTest` is only reached at all when `opts.prevalueOf`
 *     and `opts.sameBranchOf` both DECLINE first (`lowerExpr`'s/`tailLoopForm`'s
 *     "If" arms, consulted in that order, ahead of `truthTest`) — a
 *     provably-constant guard or an identical-both-branches value folds the
 *     whole `If` away, guard and all, even where `facts.boolean` is never
 *     proven. Both folds are declared "decline is always safe" (`WalkOptions`'s
 *     own doc) and only ever ADD clean residuals on top of the facts.boolean
 *     path this module already counts — they never take one away. So this
 *     module's `If`-clean count is a conservative UNDER-count of what the real
 *     pipeline emits, not the exact figure the pre-E2/E3 argument here used to
 *     claim.
 *   - `App(car|cdr|…)`: `walk.ts`'s `lowerApp` consults `opts.idiomAt` FIRST,
 *     before the registry ladder this module recomputes (`reachesEmitRule`,
 *     below) — a matching idiom (`../peepholes/index.ts`'s scalar-fold,
 *     matching exactly this `App(car, [inner])` shape) fuses the site into a
 *     different residual entirely, bypassing the plain rung-1 reachability
 *     check. Same direction as `If`: an optional, decline-is-safe fold this
 *     module doesn't replicate, so its car-family clean count is likewise a
 *     lower bound, not an exact reading. When the head IS resolved through the
 *     ordinary ladder (no idiom fired), the rest of the original argument still
 *     holds: `lowerApp` only reaches the registry's rule (rung 1, the
 *     idiomatic residual) when the head is UNRESOLVED lexically
 *     (`resolve(name) === undefined`) and the registry row carries an `emit`
 *     rule (`row.kind !== "door" && row.emit !== undefined`) — car/cdr/cxr's
 *     Phase-1 rules are UNCONDITIONAL (no fact-gating: "No guard, no shim, no
 *     mode", constitution §4.3). The one input this module does not
 *     independently re-derive is lexical resolution (`resolve()` in walk.ts,
 *     scope-aware) — see `assertNoCxrShadowing` below for how that gap is
 *     closed cheaply instead of ported wholesale.
 *
 * This means (b) is not a text-shape-matching approximation — it reads two of
 * the walker's real inputs (facts, registry) directly off the structures that
 * ARE the inputs — but per the above it is a SOUND LOWER BOUND on `walk()`'s
 * actual clean rate for `If` and car-family sites, not a byte-exact replica of
 * every path to "clean": the metric can under-report, never over-report,
 * relative to what `compileGreenfield` actually emits.
 *
 * ── The shadowing gap ────────────────────────────────────────────────────────
 * `walk()`'s registry rung is only reached when the symbol is not a LOCAL
 * binding (`(let ((car car-ish)) (car xs))` would call the local, never the
 * registry rule). Porting the walker's full scope stack (`schemeFrames`/
 * `resolve`/`inSchemeFrame`) just to answer "is `car` ever shadowed" would cost
 * as much machinery as `walk()` itself. Instead: a single flat scan collects
 * EVERY name ever bound anywhere in the program (params, let/letrec bindings,
 * named-let loop names, defines) and `measureProgram` throws if any cxr-family
 * name appears in it. A real corpus program that shadows `car` is corpus-authoring
 * malpractice for THIS package's purposes (arrival's own registry symbols are
 * not reasonable rebinding targets) — the throw makes that assumption an
 * enforced invariant instead of a silent blind spot, and costs a few lines
 * instead of a scope stack.
 *
 * ── Lens-warned UB sites ─────────────────────────────────────────────────────
 * The metric excludes "lens-warned UB sites" (constitution §5.2 Law U: the lens
 * WARNS on unproven `car`/cxr use, e.g. `(car '())`, at compile time). No such
 * warning channel exists in this package yet (grepped: `typefacts/`, `type-emit/`
 * carry no warning emission) — the exclusion is currently VACUOUS. Reported as
 * `lensWarnedUBExcluded: 0` rather than silently omitted, so a future warning
 * channel's absence-or-presence is visible in the report shape itself.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  classify,
  desugar,
  extractFacts,
  greenfieldRegistryFor,
  narrowsMembersOf,
  parseSexprs,
  type CoreForm,
  type OracleSession,
  type OverlayEmitRegistry,
} from "../index.js";
import { collectAllBoundNames } from "../propagate/index.js";

/** R7RS's generative cxr family, depth 1–4: car, cdr, caar, cadr, …, cddddr. */
const CXR_RE = /^c[ad]{1,4}r$/;

export interface SiteCounts {
  readonly sites: number;
  readonly clean: number;
}

export interface ProgramReport {
  readonly name: string;
  /** Package-relative (never absolute — a committed report must read identically
   *  on every checkout/CI runner, not just the machine that generated it). */
  readonly sourcePath: string;
  /** classify()'s own door count — must be 0 for a corpus entry ("parses
   *  through OUR front… without malformed doors"); reported, not just asserted,
   *  so a future corpus edit that regresses this is visible in the JSON diff. */
  readonly doors: number;
  readonly carFamily: SiteCounts & { readonly bySymbol: Readonly<Record<string, SiteCounts>> };
  readonly if: SiteCounts;
  /** Informational (constitution §9: "informational columns for map/filter/cxr
   *  clean-% … the gate keys on car/if") — NOT part of the gate's denominator. */
  readonly map: SiteCounts;
  readonly filter: SiteCounts;
}

export interface Gate1Report {
  readonly note: string;
  readonly perProgram: readonly ProgramReport[];
  readonly totals: {
    readonly carSites: number;
    readonly carClean: number;
    readonly ifSites: number;
    readonly ifClean: number;
    readonly cleanPct: number;
    readonly mapSites: number;
    readonly mapClean: number;
    readonly filterSites: number;
    readonly filterClean: number;
  };
  readonly sampleSizeGuard: {
    readonly threshold: number;
    readonly measured: number;
    readonly passed: boolean;
  };
  readonly lensWarnedUBExcluded: number;
}

/** Generic pre-order visitor over the classified forest — mirrors classify's own
 *  shapes (coreform/types.ts) and typefacts/extract.ts's `walkProgram` traversal;
 *  a third independent copy is preferable to importing a private helper across
 *  modules that evolve for different reasons (facts extraction vs. site counting). */
function forEachNode(node: CoreForm, visit: (n: CoreForm) => void): void {
  visit(node);
  switch (node.kind) {
    case "Define":
      forEachNode(node.value, visit);
      if (node.overridableType !== undefined) forEachNode(node.overridableType, visit);
      return;
    case "DefineFn":
      if (node.overridableType !== undefined) forEachNode(node.overridableType, visit);
      for (const f of node.body) forEachNode(f, visit);
      return;
    case "Lambda":
      for (const f of node.body) forEachNode(f, visit);
      return;
    case "If":
      forEachNode(node.cond, visit);
      forEachNode(node.then, visit);
      forEachNode(node.else, visit);
      return;
    case "And":
    case "Or":
      for (const a of node.args) forEachNode(a, visit);
      return;
    case "Let":
    case "NamedLet":
      for (const b of node.bindings) forEachNode(b.init, visit);
      for (const f of node.body) forEachNode(f, visit);
      return;
    case "Begin":
      for (const f of node.body) forEachNode(f, visit);
      return;
    case "App":
      forEachNode(node.fn, visit);
      for (const a of node.positionalArgs) forEachNode(a, visit);
      for (const kw of node.kwargs) forEachNode(kw.value, visit);
      return;
    case "Dict":
      for (const e of node.entries) forEachNode(e.value, visit);
      return;
    default:
      // Ref | Lit | Quote | Require | Door — leaves; nothing further to visit.
      return;
  }
}

/** Throws if any cxr-family name is ever locally bound — the one input
 *  `measureProgram`'s cheap registry-only check does not independently
 *  re-derive from the walker (see module header). The census itself
 *  (params, let-family bindings, named-let loop names, defines — a flat
 *  over-approximation of "could shadow a registry symbol", cheap enough to
 *  not need real scope nesting; see the module header's shadowing-gap note)
 *  is `../propagate/index.ts`'s `collectAllBoundNames` — THE single source
 *  for this walk (WALKER-NAMING audit finding #3): this file used to carry
 *  its own independent re-derivation of the identical CoreForm walk, with
 *  no `assertNever` on either copy's kind switch, so a future CoreForm kind
 *  could silently go uncensused in one copy while the other (correctly or
 *  not) picked it up. */
function assertNoCxrShadowing(programName: string, forms: readonly CoreForm[]): void {
  const bound = [...collectAllBoundNames(forms)].filter((n) => CXR_RE.test(n));
  if (bound.length > 0) {
    throw new Error(
      `gate1/measure: "${programName}" locally binds ${bound.join(", ")} — the cheap ` +
        `registry-only clean check assumes no cxr-family symbol is ever shadowed. ` +
        `Extend measureProgram with real scope resolution (mirroring walk.ts's ` +
        `resolve/schemeFrames) before trusting this corpus entry's carFamily counts.`,
    );
  }
}

/** Rung-1 reached ⇔ the registry names a non-door row carrying an `emit` rule —
 *  the walker's OWN ladder (`ruleOf(row) !== undefined`, `EmitRule.call` is
 *  required by the type, so `row.emit !== undefined` is exactly `ruleOf`'s
 *  truthiness) at the exact two checks `lowerApp`/`registryValueRef` make before
 *  falling to a `RuntimeRef` shim or an unresolved-identifier door. */
function reachesEmitRule(registry: OverlayEmitRegistry, symbol: string): boolean {
  const row = registry.lookup(symbol);
  return row !== undefined && row.kind !== "door" && row.emit !== undefined;
}

export interface MeasureOptions {
  readonly registry: OverlayEmitRegistry;
  readonly narrowsMembers: ReadonlySet<string>;
}

/** Measure one corpus program. Runs the SAME front (classify/extractFacts) the
 *  real pipeline runs, on the raw (unwrapped) source — this module never needs
 *  compileGreenfield's oracle-observability wrap, since nothing here executes
 *  anything; it only inspects the classified tree and the fact table. */
export function measureProgram(name: string, sourcePath: string, source: string, opts: MeasureOptions): ProgramReport {
  const classified = classify(desugar(parseSexprs(source)));
  assertNoCxrShadowing(name, classified.forms);

  const extraction = extractFacts({ source, classified }, { narrowsMembers: opts.narrowsMembers });

  let carSites = 0;
  let carClean = 0;
  const bySymbol = new Map<string, { sites: number; clean: number }>();
  let ifSites = 0;
  let ifClean = 0;
  let mapSites = 0;
  let mapClean = 0;
  let filterSites = 0;
  let filterClean = 0;

  const bumpSymbol = (symbol: string, clean: boolean): void => {
    const prev = bySymbol.get(symbol) ?? { sites: 0, clean: 0 };
    bySymbol.set(symbol, { sites: prev.sites + 1, clean: prev.clean + (clean ? 1 : 0) });
  };

  const visit = (n: CoreForm): void => {
    if (n.kind === "If") {
      ifSites++;
      // register "run" (the frozen metric): clean iff facts.boolean proves the
      // condition — walk.ts's truthTest verbatim, minus the "read"-register branch.
      // NOTE this is a lower bound, not the walker's only path to clean here:
      // `walk()` also consults `prevalueOf`/`sameBranchOf` (module header,
      // "Instrument choice") ahead of truthTest, which can fold the whole `If`
      // away even where facts.boolean is never proven — this module doesn't
      // replicate those folds, so it can under-count If-clean, never over-count.
      if (extraction.facts.get(n.cond.id)?.boolean === true) ifClean++;
      return;
    }
    if (n.kind === "App" && n.fn.kind === "Ref") {
      const symbol = n.fn.name;
      if (CXR_RE.test(symbol)) {
        const clean = reachesEmitRule(opts.registry, symbol);
        carSites++;
        if (clean) carClean++;
        bumpSymbol(symbol, clean);
      } else if (symbol === "map") {
        mapSites++;
        if (reachesEmitRule(opts.registry, symbol)) mapClean++;
      } else if (symbol === "filter") {
        filterSites++;
        const firstArg = n.positionalArgs[0];
        const clean =
          reachesEmitRule(opts.registry, symbol) &&
          firstArg !== undefined &&
          extraction.facts.get(firstArg.id)?.boolean === true;
        if (clean) filterClean++;
      }
    }
  };
  for (const form of classified.forms) forEachNode(form, visit);

  return {
    name,
    sourcePath,
    doors: classified.doors.length,
    carFamily: { sites: carSites, clean: carClean, bySymbol: Object.fromEntries(bySymbol) },
    if: { sites: ifSites, clean: ifClean },
    map: { sites: mapSites, clean: mapClean },
    filter: { sites: filterSites, clean: filterClean },
  };
}

export interface Gate1ManifestEntry {
  readonly name: string;
  readonly fileName: string;
}

/**
 * The committed gate1-corpus manifest (constitution §9: "a committed
 * `gate1-corpus` manifest — real programs selected by site-density criteria").
 * Originally three named programs, scouted from: mercury's `fixtures/sources/
 * *.scm`, the gepa example sources it's drawn from, and `ai-winter-thawed/scm/
 * *.scm` (see the scout report for the rejected candidates and density counts).
 *
 * R5a WIDENING (known caveat closed): the original three-program manifest was
 * 92% concentrated in `inhuman-gepa-full.scm` alone (35 of 38 total car/if
 * sites) — a healthy denominator riding almost entirely on one file's shape.
 * Three more real programs join it, scouted this wave from `inhuman/examples/`
 * (the broader example-project pool beyond the gepa variants already present)
 * and picked purely by MEASURED site density (`measureProgram`, never
 * eyeballed) — never by which direction they'd push the clean%, per the
 * "if the number drops, that is information, not failure" ruling:
 *   - `inhuman-custdev-best-tagline.scm` — 39 car/if sites (16 car, 23 if), the
 *     single densest real program found across every scouted directory this
 *     wave (more than doubling the ORIGINAL manifest's total denominator on its
 *     own): a recursive hill-climb with a hierarchical audience-split.
 *   - `inhuman-geo.scm` — 12 sites (5 car, 7 if), a bounded-recursion
 *     convergence loop with a second constraining judge.
 *   - `inhuman-reference-interview.scm` — 10 sites (4 car, 6 if), a stateless
 *     interview → consolidate → audit pipeline.
 *
 * The metric definition itself (site/clean/denominator rules, `measureProgram`,
 * `SAMPLE_SIZE_THRESHOLD`) is UNCHANGED — only the sample widens. New
 * concentration: `inhuman-gepa-full.scm` is now 35 of 99 total sites (35.4%),
 * spread across six real, differently-shaped programs instead of three.
 *
 * Files live copy-as-chunk under `src/__tests__/fixtures/gate1-corpus/` — each
 * carries its own "Selection rationale" header recording why IT was chosen.
 */
export const GATE1_MANIFEST: readonly Gate1ManifestEntry[] = [
  { name: "inhuman-gepa-full", fileName: "inhuman-gepa-full.scm" },
  { name: "mercury-fixture-gepa", fileName: "mercury-fixture-gepa.scm" },
  { name: "ai-winter-ebl-investigation", fileName: "ai-winter-ebl-investigation.scm" },
  { name: "inhuman-custdev-best-tagline", fileName: "inhuman-custdev-best-tagline.scm" },
  { name: "inhuman-geo", fileName: "inhuman-geo.scm" },
  { name: "inhuman-reference-interview", fileName: "inhuman-reference-interview.scm" },
];

export const GATE1_CORPUS_DIR = fileURLToPath(new URL("../__tests__/fixtures/gate1-corpus/", import.meta.url));

/** Package-relative corpus directory — the portable half of every `sourcePath`
 *  the report emits (see `ProgramReport.sourcePath`'s doc). */
const GATE1_CORPUS_RELATIVE = "src/__tests__/fixtures/gate1-corpus/";

/** Constitution §9: "Gate 1 fails closed on insufficient sample (too few sites
 *  ⇒ extend the corpus, never re-scope on noise)". Three arbitrary programs
 *  would yield a denominator where 25% is a handful of sites — noise; below
 *  this floor `runGate1Measurement` throws instead of returning a report. */
export const SAMPLE_SIZE_THRESHOLD = 20;

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** Run the frozen Gate-1 metric over the committed manifest. One registry
 *  harvest, shared across all three programs (mirrors the oracle harness's
 *  §4.1 per-session reuse contract). Throws if the sample-size guard fails —
 *  a report is never returned for a corpus too thin to mean anything. */
export function runGate1Measurement(session: OracleSession): Gate1Report {
  // The REAL compile-path registry (ambient harvest + srfi-1 static fallback +
  // phase1Rules overlay) — never re-derive this inline. An earlier inline
  // `withRules(emitRegistryOf(session.ambient), phase1Rules)` here skipped the
  // srfi-1 merge `greenfieldRegistryFor` exists to apply, so this module scored
  // `filter` (an srfi-1 symbol) 0% clean while the pipeline actually emits it
  // clean — see `greenfieldRegistryFor`'s own doc (oracle/harness.ts) for the
  // ambient-gap this closes.
  const registry = greenfieldRegistryFor(session);
  const narrowsMembers = narrowsMembersOf(registry);

  const perProgram = GATE1_MANIFEST.map((entry) => {
    const source = readFileSync(`${GATE1_CORPUS_DIR}${entry.fileName}`, "utf8");
    const sourcePath = `${GATE1_CORPUS_RELATIVE}${entry.fileName}`;
    return measureProgram(entry.name, sourcePath, source, { registry, narrowsMembers });
  });

  const carSites = sum(perProgram.map((p) => p.carFamily.sites));
  const carClean = sum(perProgram.map((p) => p.carFamily.clean));
  const ifSites = sum(perProgram.map((p) => p.if.sites));
  const ifClean = sum(perProgram.map((p) => p.if.clean));
  const mapSites = sum(perProgram.map((p) => p.map.sites));
  const mapClean = sum(perProgram.map((p) => p.map.clean));
  const filterSites = sum(perProgram.map((p) => p.filter.sites));
  const filterClean = sum(perProgram.map((p) => p.filter.clean));

  const measured = carSites + ifSites;
  if (measured < SAMPLE_SIZE_THRESHOLD) {
    throw new Error(
      `Gate 1 fails closed: the manifest corpus has only ${measured} car/if sites, ` +
        `below the ${SAMPLE_SIZE_THRESHOLD}-site floor (constitution §9: "too few sites ⇒ ` +
        `extend the corpus, never re-scope on noise"). Add another real program to GATE1_MANIFEST.`,
    );
  }

  return {
    note:
      "Gate 1 measures type availability, register \"run\", over the committed gate1-corpus " +
      "manifest. This module does not interpret the number against the 25% band — that " +
      "readout belongs to the gate agent and V (constitution §9's ⚖️-ruled threshold).",
    perProgram,
    totals: {
      carSites,
      carClean,
      ifSites,
      ifClean,
      cleanPct: measured === 0 ? 0 : ((carClean + ifClean) / measured) * 100,
      mapSites,
      mapClean,
      filterSites,
      filterClean,
    },
    sampleSizeGuard: { threshold: SAMPLE_SIZE_THRESHOLD, measured, passed: true },
    lensWarnedUBExcluded: 0,
  };
}
