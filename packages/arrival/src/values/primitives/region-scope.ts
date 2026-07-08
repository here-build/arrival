/**
 * Region discipline for reverse-crossed callables (scheme→JS), per
 * docs/working-proposals/reverse-membrane-for-callables.md §7c.
 *
 * A reverse lambda (a scheme callable handed to host JS — via `schemeToJs`'s
 * ACallable branch, or `z.procedure().decode`'s typed path) is region-bound to
 * the symbol invocation that exported it: the wrapper closes over a scope
 * token minted for THAT ONE call, and every rule below is enforced against
 * that token, never a global flag.
 *
 * ── Why an ambient holder ─────────────────────────────────────────────────
 * `z.procedure`'s `decode` is a plain zod-codec transform, `(callable) =>
 * wrapper` — zod's codec API gives it no side channel for "which invocation is
 * this a reverse crossing of". Rather than invent two different plumbing
 * conventions (an explicit parameter for `schemeToJs`, something ad hoc for
 * the codec), both paths read the SAME ambient "current region scope" —
 * mirroring the module-level holder pattern `eval/dynamic-call-site.ts` and
 * `eval/evaluator.ts`'s own run-env holder already use for the same reason:
 * single-threaded JS makes a module holder safe, and save/restore around the
 * owning call (`withRegionScope`) handles nesting. The wrapper CLOSES OVER
 * whatever scope is ambient at the moment it is minted (§7c: "wrapper closes
 * over an invocation-scope token") — never re-reads the holder later, so a
 * wrapper invoked long after its minting call keeps pointing at the SAME
 * (by then closed) scope.
 *
 * ── What lives outside this file ─────────────────────────────────────────
 * Minting/opening a scope is the crossing seam's job (`rosetta.ts`'s
 * `createRosettaWrapper`, `scheme-zod.ts`'s `z.procedure`) — this module only
 * owns the token shape, the ambient holder, and the two educational doors.
 */

import { CONSTANT_CTX, type RunContext } from "./RunContext.js";

/** Shared by every RegionScope that never had a run signal to derive from
 *  (e.g. a direct-JS caller with no ctx at all — the same "no ambient scope"
 *  fallback every reverse-membrane consumer degrades to). Never fires, so
 *  sharing one instance across every unscoped wrapper adds no listener cost. */
const NEVER_ABORTS: AbortSignal = new AbortController().signal;

/**
 * The invocation-scope token a reverse wrapper closes over (§7c). `open`/
 * `pending` are mutated in place by `withRegionCall`/`closeRegionScope` — the
 * SAME object every wrapper minted against this scope shares, so the escape
 * door and the incomplete-call door see one source of truth.
 */
export interface RegionScope {
  /** False once the exporting symbol invocation has returned — every call
   *  after that point is an escape (rule 1). */
  open: boolean;
  /** Count of reverse calls started but not yet settled. Read at close time
   *  (rule 2) and decremented as each call settles (rule 3). */
  pending: number;
  /** Derived from the run's abort signal (rule 4) — never an independently
   *  triggerable signal; there is no "cancel this one scope" knob. */
  readonly signal: AbortSignal;
  /** The enclosing symbol invocation's RunContext — reverse-entry args mint
   *  under THIS, never `CONSTANT_CTX` (§7b). */
  readonly runCtx: RunContext;
  /** The enclosing symbol invocation, opaque here (the tap owns its shape;
   *  see `eval/evaluator.ts`'s own `Invocation = unknown`). Threaded to
   *  `withDynamicCallSite` so a re-entry's trace nests under THIS invocation
   *  instead of the lambda's definition-time lexical one (§7b/§9). */
  readonly dynSite: unknown;
  /** Per-(callable, scope) wrapper identity (§7c): the same callable exported
   *  twice through this SAME scope gets back the SAME JS function. A WeakMap
   *  keyed by the callable value itself, owned by the scope — a fresh scope
   *  starts with a fresh, empty cache, so two invocations of the same symbol
   *  each get their own wrapper (never `===` across scopes). */
  readonly cache: WeakMap<object, (...args: unknown[]) => unknown>;
}

/**
 * Shared, permanently-open fallback scope for a reverse-membrane wrapper minted
 * OUTSIDE any real crossing — no `createRosettaWrapper`/`z.procedure` call is
 * live around it (a trace/display projection, e.g. `provenance/uneval.ts`
 * reaching `schemeToJs` directly, or a unit test calling `z.procedure(...)
 * .parse(...)` with no ambient scope set up). No symbol invocation exported the
 * resulting wrapper, so there is nothing to close and no escape/incomplete rule
 * to enforce — region.law's rows are about a REAL crossing; this is the
 * documented "no discipline" degradation for everything else, shared by both
 * consumers (`rosetta.ts`'s `schemeToJs`, `scheme-zod.ts`'s `z.procedure`) so
 * a callable crossing through either path outside a tracked invocation still
 * gets ONE (never-closing) identity cache instead of two independent ones.
 */
export const DETACHED_SCOPE: RegionScope = {
  open: true,
  pending: 0,
  signal: NEVER_ABORTS,
  runCtx: CONSTANT_CTX,
  dynSite: undefined,
  cache: new WeakMap(),
};

/** Mint a fresh, open scope for one symbol invocation. `parentSignal` is the
 *  enclosing RunContext's signal (`undefined` for a run with no budget/abort
 *  wiring, e.g. `CONSTANT_CTX`) — derived via `AbortSignal.any`, a genuine
 *  child signal, not the parent's own reference, so this scope's listener is
 *  independently disposed when the scope is GC'd rather than outliving it
 *  pinned to the run's controller. */
export function openRegionScope(opts: { runCtx: RunContext; dynSite: unknown }): RegionScope {
  const parentSignal = opts.runCtx.signal;
  return {
    open: true,
    pending: 0,
    signal: parentSignal === undefined ? NEVER_ABORTS : AbortSignal.any([parentSignal]),
    runCtx: opts.runCtx,
    dynSite: opts.dynSite,
    cache: new WeakMap(),
  };
}

/** Rule 1's door (errors-as-doors: names the mechanism, then the fix). */
export function regionEscapeDoor(): Error {
  return new Error(
    "reverse lambda escaped its invocation — callbacks are region-bound to the calling symbol; " +
      "a wrapper handed to host JS may only be invoked WHILE the symbol call that exported it is " +
      "still running. Persistent handlers (a subscription kept past the call's return) need an " +
      "explicit capability granting a DETACHED scope — this is not that, by default.",
  );
}

/** Rule 2's door. */
function regionIncompleteDoor(pending: number): Error {
  return new Error(
    `symbol returned with ${pending} reverse-lambda call${pending === 1 ? "" : "s"} incomplete — ` +
      "every reverse-lambda call started during a symbol invocation must settle (resolve or reject) " +
      "before that symbol returns. Await each re-entry, or use a persistent-handler capability for " +
      "fire-and-forget work instead of leaving a call in flight.",
  );
}

/**
 * Close `scope` — called once, when the exporting symbol invocation settles
 * (rule 2). Flips `open` false FIRST (so a call that starts racing the close
 * still sees the door), then throws if any call is still in flight. Throwing
 * here (inside the crossing seam's `finally`) supersedes a normal return —
 * the settling symbol's own result is discarded in favor of the teaching
 * error, which is the point: an incomplete re-entry is a caller bug, not a
 * warning.
 */
export function closeRegionScope(scope: RegionScope): void {
  scope.open = false;
  if (scope.pending > 0) throw regionIncompleteDoor(scope.pending);
}

/**
 * Run one reverse-lambda call under `scope`'s discipline (rules 1/3/4): door
 * if the scope already closed, else track `pending` for the call's lifetime
 * and race it against the scope's abort signal. `fn` is the actual re-entry
 * (jsToScheme the args → applyCallback → schemeToJs the result) — this
 * wrapper owns only the bookkeeping around it, never the marshaling.
 */
export async function withRegionCall<T>(scope: RegionScope, fn: () => Promise<T> | T): Promise<T> {
  if (!scope.open) throw regionEscapeDoor();
  scope.pending++;
  try {
    return await raceRegionAbort(Promise.resolve().then(fn), scope.signal);
  } finally {
    scope.pending--;
  }
}

/**
 * Reject `value` the moment `signal` aborts, without waiting for `value`
 * itself to settle — the in-flight-cancellation half of rule 4. Deliberately
 * NOT imported from `eval/evaluator.ts`'s `raceAbort` (byte-identical logic):
 * this leaf module is reached from `rosetta.ts`/`scheme-zod.ts`, which sit
 * BELOW the evaluator in the dependency order (host-agnostic FFI leaves —
 * see `docs/reference/arrival-graal-guest-not-host-dsl.md`); pulling in the
 * ~3300-line evaluator module for one Promise/AbortSignal helper would be a
 * real layering violation for a 15-line utility. The abandoned promise's
 * eventual settlement is swallowed so it never surfaces as an unhandled
 * rejection, mirroring `raceAbort`'s own contract.
 */
function raceRegionAbort<T>(value: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void Promise.resolve(value).catch(() => {});
    return Promise.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// ── Ambient "current region scope" ──────────────────────────────────────────
// See the file header for why this is ambient rather than threaded through
// `RosettaOptions`: `z.procedure`'s codec transform has no parameter for it.
// Single-threaded JS + save/restore around the owning call makes the holder
// safe, exactly like evaluator.ts's `_dynamicCallSite`.
let _currentRegionScope: RegionScope | undefined = undefined;

/** The scope a reverse wrapper should close over if minted RIGHT NOW —
 *  `undefined` outside any tracked crossing (e.g. `z.procedure().parse(...)`
 *  called directly in a unit test, or `schemeToJs` reached from a trace/
 *  display path that never opened a scope). Callers must treat `undefined`
 *  as "no region discipline for this wrapper" (an always-open, uncached,
 *  never-region-bound passthrough) — never as an error. */
export function currentRegionScope(): RegionScope | undefined {
  return _currentRegionScope;
}

/** Install `scope` as ambient for the duration of `fn` (sync only — every
 *  real caller mints wrappers synchronously; the crossing's own async work
 *  happens outside this window, see `createRosettaWrapper`). */
export function withRegionScope<T>(scope: RegionScope, fn: () => T): T {
  const saved = _currentRegionScope;
  _currentRegionScope = scope;
  try {
    return fn();
  } finally {
    _currentRegionScope = saved;
  }
}
