/**
 * The runtime half of `(run/continue-after-approval spec result)` — a
 * human-in-the-loop gate in front of an irreversible action.
 *
 * The authoring front is a preamble macro (see `SUPERDEFINE_PREAMBLE`) that
 * THUNKS the result so the to-be-approved value isn't computed until permission
 * lands:
 *
 *   (run/continue-after-approval spec result)
 *     ⇒ (approval/await spec (lambda () result))
 *
 * So the interpreter core only ever sees an ordinary call + a lambda — no
 * domain concept leaks into the pure dataflow core (the membrane rule). The
 * rosetta is async (mirroring the `infer` rosetta): it constructs a
 * {@link FunctionRunApprovalRequest}, hands it to an optional host sink
 * (`onApprovalRequest`), and AWAITS a human's verdict by observing the request's
 * `result`. On approval it CALLS the thunk (running `result` for the first time)
 * and returns its value — the go-token the downstream irreversible action
 * structurally consumes. On rejection it throws, so that branch fails and the
 * action never fires.
 *
 * The membrane/replay principle: every effect is a recorded membrane
 * penetration, and this approval is one more async penetration — the value only
 * crosses back once a human has signed off.
 *
 * LOCAL-FIRST: when no real approver is wired (`onApprovalRequest` absent), the
 * request auto-approves immediately so local/sandbox runs never block.
 */
import type { SchemeEnv, SchemeValue } from "@inhuman.tools/arrival";
import { applyCallback, EnvCapability, is_callable_value, schemeToJs, symbol, z, type RunContext } from "@inhuman.tools/arrival";
import type { CallCtx } from "@inhuman.tools/arrival/symbol";
import { action, makeObservable, observable, when } from "mobx";

/** The form head the preamble macro lowers to. */
export const APPROVAL_FORM = "approval/await";

/** Verdict: APPROVED. Carries an optional value override (reserved — a human
 *  substituting the result) and audit metadata (`by`). */
export class FunctionRunApprovalResult {
  constructor(
    /** Audit: who approved (a principal ref). */
    readonly by?: unknown,
    /** Optional value override — when present, wins over the thunk's value.
     *  Reserved for "edit-then-approve"; absent in the plain-approve path. */
    readonly value?: unknown,
  ) {}
}

/** Verdict: REJECTED. Carries an optional reason + audit metadata. */
export class FunctionRunApprovalReject {
  constructor(
    readonly reason?: unknown,
    /** Audit: who rejected. */
    readonly by?: unknown,
  ) {}
}

/**
 * A reactive comms channel for ONE pending approval. The run awaits resolution
 * by observing `result` flip from `null` to a verdict variant. A host surfaces
 * `spec` to a human, who calls `approve(...)` or `reject(...)`.
 *
 * Invalid states are unrepresentable: `result` is the resolution itself
 * (`null` = pending · `Result` = approved · `Reject` = rejected), so "approved
 * AND rejected" cannot occur, and a reason can only ride a rejection. The two
 * mutators are the only transitions and are single-use — once `result` is set,
 * a second `approve`/`reject` is inert (late/double verdicts are dead).
 *
 * mobx-observable so a UI (or the awaiting rosetta's `when`) reacts to the
 * verdict without polling.
 */
export class FunctionRunApprovalRequest {
  /** The approval descriptor surfaced to a human (action/args/why/collect-schema). */
  readonly spec: unknown;
  /** The resolution: `null` while pending, then exactly one verdict variant. */
  result: null | FunctionRunApprovalResult | FunctionRunApprovalReject = null;

  constructor(spec: unknown) {
    this.spec = spec;
    makeObservable(this, {
      result: observable.ref,
      approve: action.bound,
      reject: action.bound,
    });
  }

  /** Approve. Optional `by` (audit) and `value` (reserved override). Inert once
   *  resolved. */
  approve(by?: unknown, value?: unknown): void {
    if (this.result) return;
    this.result = new FunctionRunApprovalResult(by, value);
  }

  /** Reject this branch with an optional reason + `by` (audit). Inert once
   *  resolved. */
  reject(reason?: unknown, by?: unknown): void {
    if (this.result) return;
    this.result = new FunctionRunApprovalReject(reason, by);
  }
}

/** Host sink for a freshly-constructed pending request. Sync or async; return
 *  ignored — the request resolves through its `result` field, not a return. */
export type OnApprovalRequest = (req: FunctionRunApprovalRequest) => void | Promise<void>;

/**
 * Optional host hook that decides a request's verdict directly (instead of, or
 * in addition to, surfacing it via `onApprovalRequest`). Return `true`/`false`
 * synchronously to approve/reject; return `undefined` to leave the verdict to
 * the async channel (`onApprovalRequest` + the observed `result`).
 */
export type ResolveApproval = (req: FunctionRunApprovalRequest) => boolean | undefined;

/** Raised when an approval is rejected — the branch fails, the action never fires. */
export class ApprovalRejected extends Error {
  constructor(readonly request: FunctionRunApprovalRequest) {
    const reject = request.result instanceof FunctionRunApprovalReject ? request.result : undefined;
    super(`approval rejected${reject?.reason ? `: ${String(reject.reason)}` : ""}`);
    this.name = "ApprovalRejected";
  }
}

/**
 * The runtime CORE of `approval/await` — thunked-approval logic, independent of any env-wiring
 * form. `defineApprovalRosetta` binds this to the legacy `env.defineRosetta` path; the baked
 * `symbol.rosetta` declaration (`capability.ts`) calls it directly from its impl. ONE
 * implementation, two binding sites — no re-homing of the approve/reject/thunk logic itself.
 *
 * `onApprovalRequest` and `resolveApproval` are both optional — omit them and a request
 * auto-approves immediately (local/sandbox: runs never block). Same "capability is optional, the
 * verb always exists" posture as `define/overridable`.
 */
export async function runApproval(
  opts: { onApprovalRequest?: OnApprovalRequest; resolveApproval?: ResolveApproval },
  spec: unknown,
  thunk: unknown,
  runCtx: RunContext,
): Promise<unknown> {
  const { onApprovalRequest, resolveApproval } = opts;
  const local = !onApprovalRequest && !resolveApproval;

  // A scheme thunk is a callable VALUE (ALambda) under callables-as-values, not a bare fn —
  // accept both and invoke through the applyCallback seam. A plain `typeof thunk === "function"`
  // narrows `unknown` to the global `Function` interface (no call signature), not the
  // `(...args: unknown[]) => unknown` shape applyCallback needs — this predicate narrows to that
  // exact shape instead.
  const isThunkFn = (x: unknown): x is (...args: unknown[]) => unknown => typeof x === "function";
  if (!isThunkFn(thunk) && !is_callable_value(thunk)) {
    throw new TypeError(`${APPROVAL_FORM}: result must be thunked (a (lambda () …)) — got ${typeof thunk}`);
  }
  const proc = () => applyCallback(thunk, [], runCtx);

  const req = new FunctionRunApprovalRequest(spec);

  // LOCAL AUTO-APPROVE — no real approver wired ⇒ release synchronously so
  // local runs never park.
  if (local) {
    req.approve();
  } else {
    // A host hook may decide the verdict directly.
    if (resolveApproval) {
      const verdict = resolveApproval(req);
      if (verdict === true) req.approve();
      else if (verdict === false) req.reject();
    }
    // Surface to the host UI/inbox unless already decided.
    if (req.result === null && onApprovalRequest) {
      await onApprovalRequest(req);
    }
    // deferred: durable teardown/resume. Today the run is held in memory until a
    // human resolves `result`; the durable variant suspends here and resumes by
    // replaying the effect-log.
    await when(() => req.result !== null);
  }

  if (req.result instanceof FunctionRunApprovalReject) throw new ApprovalRejected(req);

  // Approved: run `result` NOW (first evaluation) — the thunk's value is the
  // go-token the downstream irreversible action consumes. A human-supplied
  // `value` override (reserved edit-then-approve path) wins over it.
  const computed = await proc();
  const verdict = req.result as FunctionRunApprovalResult;
  return verdict.value === undefined ? computed : verdict.value;
}

/** The legacy `env.defineRosetta` binding of {@link runApproval} — kept as its own public,
 *  independently-callable entry point (index.ts export surface; a host may build its own env
 *  directly against `SchemeEnv` without going through the capability). Migrated off the retired
 *  `env.defineRosetta` membrane onto a private, single-symbol `EnvCapability` — the SAME
 *  `symbol.rosetta` declaration shape `arrivalApprovalCapability` binds for `approval/await`,
 *  minus that capability's `run/continue-after-approval` macro (this function's legacy
 *  contract only ever bound the one verb).
 *
 *  `provenance: "pipe"` is the modern spelling of the legacy `pure: true` — a lineage-ROLE fact
 *  (never a `cacheClass`; see the NAMING HAZARD note on `Contract.cacheClass` in arrival's
 *  `_bake.ts`). Preserved here for the SAME security reason the old comment named: this form is a
 *  GATE forwarding the approved thunk's value through a human decision, introducing no data of
 *  its own — a "source"-role rosetta would MINT a fresh point over the result, replacing the
 *  upstream attribution (e.g. the `infer` that produced the value) and flipping a fabricated-
 *  literal thunk from ungrounded→grounded (a seal-laundering vector).
 *
 *  `void`-fires `lower().apply(env)` rather than awaiting: this capability declares no
 *  `prelude`/`resources`, so `apply`'s async body (capability.ts) never reaches an `await` before
 *  the symbol lands on `env` — the bind loop runs to completion synchronously. That keeps this
 *  function's own signature `void` (unchanged from the legacy `env.defineRosetta` call, which was
 *  itself synchronous), rather than turning every host caller into an async one for a capability
 *  that structurally can't suspend. */
export function defineApprovalRosetta(opts: {
  env: SchemeEnv;
  onApprovalRequest?: OnApprovalRequest;
  resolveApproval?: ResolveApproval;
}): void {
  const { env, onApprovalRequest, resolveApproval } = opts;
  const cap = new EnvCapability("arrival/approval-legacy", {
    configuration: {
      onApprovalRequest: z.custom<OnApprovalRequest>((v) => typeof v === "function").optional(),
      resolveApproval: z.custom<ResolveApproval>((v) => typeof v === "function").optional(),
    },
    symbols: ({ configuration }) => ({
      [APPROVAL_FORM]: symbol.rosetta`approval/await: awaits human approval for a spec before evaluating the thunked result`(
        { input: z.array(z.value), output: [z.value], provenance: "pipe", type: "(spec: unknown, thunk: unknown): unknown" },
        // Boundary assert: runApproval forwards the thunk's value (unknown by design); the
        // z.value contract demands SchemeValue — asserted at the verb table, same as
        // arrivalSuperDefineCapability's binding of the identical impl.
        (function (this: CallCtx, spec: unknown, thunk: unknown) {
          return runApproval(
            { onApprovalRequest: configuration.onApprovalRequest, resolveApproval: configuration.resolveApproval },
            schemeToJs(spec as SchemeValue, {}), // boundary narrow — same assert as the impl's `as never`
            thunk,
            this.runCtx,
          );
        }) as never,
      ),
    }),
  });
  // `undefined as never` for `ctx`: this is a bare direct apply outside any kernel assembly (no
  // `PackContext` to hand it — no prelude on this capability needs `ctx.preludeScope` either),
  // the same idiom arrival core's own capability tests use (e.g.
  // `env/srfi/__tests__/srfi-1-symbol-define.test.ts`'s `cap.lower(...).apply(env, undefined as never)`).
  void cap.lower({ config: { onApprovalRequest, resolveApproval } }).apply(env, undefined as never);
}
