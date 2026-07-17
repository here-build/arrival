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
 * Built on the oracle session shape (`../oracle/harness.ts::openOracleSession`):
 * ONE reusable `buildArrivalSession` capability-DAG assembly (the expensive
 * part, §2.4's reuse contract), held across every baseline/probe re-run — a
 * FRESH `LexicalScope` per evaluated program, so one program's defines never
 * leak into the next, exactly as the oracle's `evalInterpreter` does.
 *
 * THE SUBSTITUTION SEAM (this file's whole reason to exist — §2.2's "the
 * probe", §2.3): the oracle's `infer` stub always THROWS ("not supported
 * outside the async-family cell") — a probe session's `infer` instead
 * ANSWERS, from a hand-authored RECORDED TABLE (`ProbeTable`): a call →
 * recorded-result map standing in for the real effect-log
 * (`@inhuman.tools/arrival-effects`'s `EffectLog`, keyed the same way —
 * `inferEffectKey`'s `[model, prompt, schema, cacheKey]` tuple). Phase B wires
 * the actual log in; because the table here is shaped identically (a call
 * resolves to a recorded value), that wiring swaps the TABLE SOURCE, not this
 * seam.
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
import { execState, LexicalScope, parseGenerator, schemeToJsUntyped } from "@inhuman.tools/arrival";
import type { AssembledAmbient } from "@inhuman.tools/arrival/env";
import { buildArrivalSession, BUILTIN_PREAMBLE, type InferFn } from "@inhuman.tools/arrival-run";

/**
 * One crossing's content identity — the `(infer …)` call-site tuple the real
 * effect-log keys by. `tools`/`params` (the agentic-loop's extra identity
 * dimensions, see `inferIdentityKey` in `@inhuman.tools/arrival-run`) are out
 * of scope for Phase A: no probe test here drives a tool-enabled call, and
 * folding them in later is additive — the same way `inferIdentityKey` folds
 * them into a plain cacheKey without disturbing the untooled case.
 */
export interface CallSignature {
  readonly model: string;
  readonly prompt: string;
  readonly schema: string | null;
  readonly cacheKey: string | null;
}

/** One hand-authored table row: the call it answers, and the RAW value
 *  `infer` resolves to for it (pre-list-wrapping — `arrivalInferCapability`'s
 *  verb does that step; this is the value an `InferFn` itself returns). */
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
 * Build the `InferFn` that IS the substitution seam (see file header). A
 * fresh instance is built per run (`runWithTable`, below) so `consumed` starts
 * empty every time — each run (baseline or probe) derives its OWN row-index
 * sequence from its OWN execution order, independent of any other run over
 * the same table.
 */
function tableBackedInfer(
  table: ProbeTable,
  calls: RecordedCall[],
  target: { readonly index: number; readonly witness: unknown } | undefined,
): InferFn {
  const consumed = new Set<number>();
  return async (_ctx, model, prompt, schema, cacheKey) => {
    const signature: CallSignature = { model, prompt, schema, cacheKey };
    const rowIndex = table.findIndex((row, i) => !consumed.has(i) && sameSignature(row.call, signature));
    if (rowIndex === -1) throw new ProbeTableMissError(signature);
    consumed.add(rowIndex);
    const result = target !== undefined && target.index === rowIndex ? target.witness : table[rowIndex]!.result;
    calls.push({ ref: { index: rowIndex }, signature, result });
    return result;
  };
}

/** One reusable capability-DAG assembly (mirrors `OracleSession` — the
 *  expensive part, held across every baseline/probe re-run of small
 *  programs). `dispose()` tears down the shared ambient. */
export interface ProbeSession extends AsyncDisposable {
  readonly ambient: AssembledAmbient;
  dispose(): Promise<void>;
}

/**
 * Per-session mutable indirection: `buildArrivalSession` bakes its `infer`
 * callable ONCE, at assembly, but `recordRun`/`probe` need DIFFERENT
 * table/target behavior on every call over that ONE assembly. The callable
 * handed to `buildArrivalSession` (`routedInfer`, below) is a STABLE
 * trampoline that reads `router.current` fresh on every invocation;
 * `recordRun`/`probe` swap what it points at for the duration of their own
 * run. This is what makes the expensive assembly reusable at all — nothing
 * about `assembleAmbient`'s own config-capture semantics needs to change for
 * a per-call-varying resolver, because the function reference it captures
 * never changes, only what that function reads.
 *
 * NOT safe for concurrent `recordRun`/`probe` calls against the SAME session:
 * the router is shared mutable state, last writer wins. Sequential use only —
 * open a second session for concurrent work.
 */
interface InferRouter {
  current?: InferFn;
  /** Single-flight guard. The router is shared mutable state; a concurrent
   *  `recordRun`/`probe` would clobber `current` mid-run and silently corrupt a
   *  verdict. This is a SECURITY harness, so silent corruption is the worst
   *  failure class — re-entry throws loudly instead. (Sequential use is the
   *  contract; open a second session for concurrent work.) */
  busy?: boolean;
}

const routerOf = new WeakMap<ProbeSession, InferRouter>();

function routedInfer(router: InferRouter): InferFn {
  return async (ctx, model, prompt, schema, cacheKey, tools, params) => {
    if (router.current === undefined) {
      throw new Error("probe session: infer called with no table bound — use recordRun/probe, not the session directly");
    }
    return router.current(ctx, model, prompt, schema, cacheKey, tools, params);
  };
}

/** Open a fresh probe session — the one expensive capability-DAG assembly,
 *  reusable across many `recordRun`/`probe` calls (§2.4's reuse contract). */
export async function openProbeSession(): Promise<ProbeSession> {
  const router: InferRouter = {};
  const inner = await buildArrivalSession({ name: "arrival-mercury-probe", infer: routedInfer(router), params: {} });
  const dispose = (): Promise<void> => inner.dispose();
  const session: ProbeSession = { ambient: inner.ambient, dispose, [Symbol.asyncDispose]: dispose };
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
    const scope = LexicalScope.fresh(`probe-${scopeCounter++}`);
    const budgetMs = DEFAULT_PROBE_BUDGET_MS;
    await execState(BUILTIN_PREAMBLE, { ambient: session.ambient, scope, budgetMs });
    const forms = await parseGenerator(source);
    let last: unknown;
    for (const form of forms) {
      const state = await execState(form, { ambient: session.ambient, scope, budgetMs });
      last = state.values.at(-1);
      if (isThenable(last)) last = await last; // the evaluator can hand back an unforced Promise
    }
    return { value: schemeToJsUntyped(last, {}), calls };
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
