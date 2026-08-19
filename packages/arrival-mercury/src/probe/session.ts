/**
 * ProbeSession — the hermetic probe harness's runtime seam, Phase A of
 * docs/foundations/arrival-scheme/provenance-by-perturbation.md (§2.2 "the
 * probe" + §2.3 "MARKED witnesses"). This is the DYNAMIC half of the design;
 * `../wire/` is the STATIC half (§3's `PVertice`/`Case`/`Literal` walk over
 * CoreForm, no execution at all). The two are deliberately separate modules
 * answering separate questions (P5: "the map answers flow… the probe answers
 * influence… two questions, two planes") — this file never imports `../wire/`,
 * and nothing here assumes the static wire map exists yet.
 *
 * Built on the session tuple (this package's `MercurySession` — the
 * `(runCtx, scope, capabilities, config)` tuple
 * `execState` mints and reuses): ONE reusable capability-DAG assembly (the
 * expensive part, §2.4's reuse contract), held across every baseline/probe
 * re-run — a FRESH `LexicalScope` per evaluated program, so one program's
 * defines never leak into the next.
 *
 * THE SUBSTITUTION SEAM (this file's whole reason to exist — §2.2's "the
 * probe", §2.3): the retired `arrival/infer` capability (and its `InferFn`
 * host hook) is gone — the LLM/MCP layer's `chat/completion` replaced it, but
 * that verb takes a model VALUE and returns a fixed `{:text …}` product, a
 * much heavier shape than this harness needs. This module instead roots its
 * OWN tiny, session-private capability (`probe/infer`, below) that binds the
 * bare scheme name `infer` to a substitution-aware impl: a call → recorded-
 * result table standing in for a recorded-result map, keyed the same way
 * (`CallSignature`'s `[model, prompt, schema, cacheKey]` tuple, same shape the
 * retired capability's own key used). Rooting it as a HOST capability
 * (`openSession`'s `capabilities`, highest precedence) makes it
 * exactly as first-class as any production verb — the corpus below spells
 * `(infer "m" "p")` exactly as it always has.
 *
 * Exactly ONE call, addressed by a `CallRef`, may be served a WITNESS instead
 * of its recorded result (`probe`); every other call is served from the table
 * exactly as `recordRun` (the baseline — no substitution at all) serves all
 * of them. Nothing about parsing, classification, or evaluation differs
 * between a baseline run and a probe run — only what `infer` answers for the
 * targeted call. That is the entire perturbation §2.2 describes: no
 * interpreter change, no carried metadata (P2) — the substitution happens
 * AT THE MEMBRANE, where effects already are.
 */
import { EnvCapability, execState, jsToScheme, LexicalScope, parse, toJS, type SchemeValue } from "@inhuman.tools/arrival";
import { openSession, type MercurySession } from "../session.js";

/**
 * One crossing's content identity — the `(infer …)` call-site tuple the real
 * effect-log keys by. `schema`/`cacheKey` are carried for shape-compatibility
 * with the retired capability's own key (and any future table row wanting
 * them); this harness's own corpus never varies them — every `(infer …)`
 * call this session's `probe/infer` capability binds is a bare 2-arg
 * `(model, prompt)` call, so both always resolve to `null` here.
 */
export interface CallSignature {
  readonly model: string;
  readonly prompt: string;
  readonly schema: string | null;
  readonly cacheKey: string | null;
}

/** One hand-authored table row: the call it answers, and the RAW value
 *  `infer` resolves to for it (pre-list-wrapping — `probe/infer`'s own impl,
 *  below, does that step; this is the value a table lookup itself answers). */
export interface ProbeTableEntry {
  readonly call: CallSignature;
  readonly result: unknown;
}

/**
 * The hand-authored stand-in for a run's effect-log (Phase A — no live log
 * wiring yet; that is Phase B). Rows are consumed in TABLE order, matched by
 * signature: a program calling `(infer "m" "p")` twice is served the table's
 * two matching rows in the order they appear, so repeated identical calls
 * disambiguate without needing a separate occurrence counter in
 * `CallSignature` itself.
 */
export type ProbeTable = readonly ProbeTableEntry[];

/** Addresses one row of a `ProbeTable` by POSITION — the crossing INSTANCE a
 *  probe targets (the design doc's "vertex instance", §2.1). Position, not
 *  signature, is the identity: two rows may share a signature (the
 *  repeated-call case above), and a probe must name ONE of them unambiguously. */
export interface CallRef {
  readonly index: number;
}

/** One crossing as `recordRun`/`probe` actually served it: which row answered
 *  (`ref` — usable directly as a later `probe`'s `target`), what was asked
 *  (`signature`), and what was served (`result`: the table's value on a
 *  baseline run, or the witness on the targeted row of a probe run). */
export interface RecordedCall {
  readonly ref: CallRef;
  readonly signature: CallSignature;
  readonly result: unknown;
}

function sameSignature(a: CallSignature, b: CallSignature): boolean {
  return a.model === b.model && a.prompt === b.prompt && a.schema === b.schema && a.cacheKey === b.cacheKey;
}

/** Hermetic-mode authoring error: the program made an `(infer …)` call with no
 *  unconsumed matching row in the table. Never a program-under-test bug —
 *  always an under-specified table (the `OracleAuthoringError` precedent in
 *  `../oracle/harness.ts`). */
export class ProbeTableMissError extends Error {
  readonly signature: CallSignature;
  constructor(signature: CallSignature) {
    super(
      `probe: no unconsumed table entry for (infer ${JSON.stringify(signature.model)} ${JSON.stringify(signature.prompt)} ` +
        `${JSON.stringify(signature.schema)} ${JSON.stringify(signature.cacheKey)}) — the hand-authored table is missing a row`,
    );
    this.name = "ProbeTableMissError";
    this.signature = signature;
  }
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v != null && typeof (v as { then?: unknown }).then === "function";

/**
 * Build the resolver that IS the substitution seam (see file header). A
 * fresh instance is built per run (`runWithTable`, below) so `consumed` starts
 * empty every time — each run (baseline or probe) derives its OWN row-index
 * sequence from its OWN execution order, independent of any other run over
 * the same table.
 */
function tableBackedInfer(
  table: ProbeTable,
  calls: RecordedCall[],
  target: { readonly index: number; readonly witness: unknown } | undefined,
): (model: string, prompt: string) => Promise<unknown> {
  const consumed = new Set<number>();
  return async (model, prompt) => {
    const signature: CallSignature = { model, prompt, schema: null, cacheKey: null };
    const rowIndex = table.findIndex((row, i) => !consumed.has(i) && sameSignature(row.call, signature));
    if (rowIndex === -1) throw new ProbeTableMissError(signature);
    consumed.add(rowIndex);
    const result = target !== undefined && target.index === rowIndex ? target.witness : table[rowIndex]!.result;
    calls.push({ ref: { index: rowIndex }, signature, result });
    return result;
  };
}

/**
 * Per-session mutable indirection: the session's `probe/infer` capability
 * (below) is rooted ONCE, at assembly, but `recordRun`/`probe` need DIFFERENT
 * table/target behavior on every call over that ONE assembly. The impl bound
 * into the capability reads `router.current` FRESH on every invocation;
 * `recordRun`/`probe` swap what it points at for the duration of their own
 * run. This is what makes the expensive assembly reusable at all — nothing
 * about the capability's own resolution needs to change for a per-call-
 * varying resolver, because the function reference it captures never
 * changes, only what that function reads.
 *
 * NOT safe for concurrent `recordRun`/`probe` calls against the SAME session:
 * the router is shared mutable state, last writer wins. Sequential use only —
 * open a second session for concurrent work.
 */
interface InferRouter {
  current?: (model: string, prompt: string) => Promise<unknown>;
  /** Single-flight guard. The router is shared mutable state; a concurrent
   *  `recordRun`/`probe` would clobber `current` mid-run and silently corrupt a
   *  verdict. This is a SECURITY harness, so silent corruption is the worst
   *  failure class — re-entry throws loudly instead. (Sequential use is the
   *  contract; open a second session for concurrent work.) */
  busy?: boolean;
}

/**
 * The session-private capability rooting `infer` (see file header — THE
 * SUBSTITUTION SEAM). A fresh instance per session (closed over that
 * session's OWN `router`), passed as a host capability at HIGHEST precedence
 * (`openSession`'s `capabilities`), so it binds `infer` exactly
 * like a production verb would — the corpus never sees a difference.
 *
 * `infer` egresses as a 1-element list (mirrors the retired `arrival/infer`
 * capability's own `inferList` wrapping) — every corpus program in this
 * package's test suite unwraps it with `car`, exactly as before.
 */
function buildProbeInferCapability(router: InferRouter): EnvCapability {
  return EnvCapability.define("probe/infer", {
    symbols: (symbol, z) => ({
      infer: symbol.rosetta`infer: probe harness substitution seam — answers from the session's bound table/witness (see this file's header)`(
        { input: [z.string, z.string], output: [z.dynamic], type: "(model: string, prompt: string): unknown" },
        async function (model: string, prompt: string) {
          if (router.current === undefined) {
            throw new Error(
              "probe session: infer called with no table bound — use recordRun/probe, not the session directly",
            );
          }
          const result = await router.current(model, prompt);
          // WORLD-FLIP RULING (2026-08-13): plain JS out — the membrane boxes (z.dynamic
          // output). The 1-element list shape is the probe corpus's own convention.
          return [result];
        },
      ),
    }),
  });
}

/** One reusable capability-DAG assembly (mirrors `OracleSession` — the
 *  expensive part, held across every baseline/probe re-run of small
 *  programs). `dispose()` tears down the shared run. Literally a
 *  `MercurySession` — no separate wrapping shape needed now that the session
 *  IS the `(runCtx, scope, capabilities, config)` tuple. */
export type ProbeSession = MercurySession;

const routerOf = new WeakMap<ProbeSession, InferRouter>();

/** Open a fresh probe session — the one expensive capability-DAG assembly,
 *  reusable across many `recordRun`/`probe` calls (§2.4's reuse contract). */
export async function openProbeSession(): Promise<ProbeSession> {
  const router: InferRouter = {};
  const session = await openSession({
    name: "arrival-mercury-probe",
    capabilities: [buildProbeInferCapability(router)],
    params: {},
  });
  routerOf.set(session, router);
  return session;
}

function routerFor(session: ProbeSession): InferRouter {
  const router = routerOf.get(session);
  if (router === undefined) throw new Error("probe: session was not opened via openProbeSession()");
  return router;
}

/**
 * Wall-clock deadline for a baseline/probe run, threaded straight into
 * arrival's own `execState` `budgetMs` — the SAME tick-checked fuel bound that
 * already caps runaway recursion (provenance-by-perturbation.md §5,
 * "non-terminating chain under a witness"). A hanging probe therefore ends in
 * a thrown `ArrivalError("execution budget exceeded…")`, an ordinary
 * catchable failure — never a wrapper timer racing an unkillable await (that
 * problem is real elsewhere — see `../oracle/harness.ts`'s ESM-loader hang
 * guard — but it doesn't apply here: we are not importing a compiled module
 * through a loader, we are re-running scheme source the interpreter already
 * bounds natively). Five seconds is generous headroom for the small,
 * hand-authored programs this harness evaluates (§2.4: probes re-run small
 * pure segments, cheaply).
 */
const DEFAULT_PROBE_BUDGET_MS = 5_000;

let scopeCounter = 0;

async function runWithTable(
  session: ProbeSession,
  source: string,
  table: ProbeTable,
  target: { readonly index: number; readonly witness: unknown } | undefined,
): Promise<{ value: unknown; calls: RecordedCall[] }> {
  const router = routerFor(session);
  if (router.busy) {
    throw new Error(
      "probe session is single-flight — a recordRun/probe is already in progress on this session; open a second session for concurrent work",
    );
  }
  const calls: RecordedCall[] = [];
  router.busy = true;
  router.current = tableBackedInfer(table, calls, target);
  try {
    // Fresh scope over the shared session — plane prelude already applied at assembly.
    const scope = LexicalScope.fresh(`probe-${scopeCounter++}`);
    const budgetMs = DEFAULT_PROBE_BUDGET_MS;
    const forms = await parse(source);
    let last: unknown;
    for (const form of forms) {
      const state = await execState(form, {
        capabilities: session.capabilities,
        config: session.config,
        scope,
        runCtx: session.runCtx,
        budgetMs,
      });
      last = state.values.at(-1);
      if (isThenable(last)) last = await last; // the evaluator can hand back an unforced Promise
    }
    return { value: toJS(last as SchemeValue), calls };
  } finally {
    router.current = undefined; // never leave a stale resolver armed for an unrelated later call
    router.busy = false;
  }
}

export interface ProbeRunResult {
  readonly value: unknown;
  readonly calls: readonly RecordedCall[];
}

/**
 * BASELINE: evaluate `source` with every `(infer …)` served straight from
 * `table` — no substitution anywhere. Returns the observable value plus every
 * crossing this run made, in EXECUTION order — `calls[i].ref` is a ready-made
 * `CallRef` for a later `probe` targeting that exact crossing instance.
 */
export async function recordRun(session: ProbeSession, source: string, table: ProbeTable): Promise<ProbeRunResult> {
  const { value, calls } = await runWithTable(session, source, table, undefined);
  return { value, calls };
}

/**
 * PROBE: identical to `recordRun`, except the crossing instance named by
 * `target` is served `witness` instead of its recorded result — the ONE
 * substitution at the capability boundary this whole mechanism performs
 * (§2.2). Every other crossing is served from `table` exactly as in the
 * baseline.
 */
export async function probe(
  session: ProbeSession,
  source: string,
  table: ProbeTable,
  target: CallRef,
  witness: unknown,
): Promise<{ value: unknown }> {
  const { value } = await runWithTable(session, source, table, { index: target.index, witness });
  return { value };
}
