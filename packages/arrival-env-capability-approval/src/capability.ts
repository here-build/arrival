// arrivalApprovalCapability (alias: arrivalSuperDefineCapability) — human-in-the-loop
// APPROVAL family: `approval/await` + `run/continue-after-approval` authoring macro.
//
// Owns the `mobx` dep (observable request channel + `when`) so arrival-run need not
// define capabilities ad hoc. Every host sink is optional config: absent a sink, the
// verb still evaluates and local-auto-approves.
//
// (The `declare/expose`/`define/exposed` "sealed skill" front that used to sit alongside these —
// `defineExposeRosetta`, `expose.ts` — was retired in the arrival-chain Phase-B cleanup: nothing
// authored it. `define/overridable` — arity `(name default schema)`, `overridable/declare` — was
// retired in the define/overridable rename sweep: the arrival core capability
// `@inhuman.tools/arrival/overridable` is now the sole claimant of the `define/overridable` head.)
//
// `approval/await` is a BAKED `symbol.rosetta` calling `runApproval` (./approval.ts).
// `defineApprovalRosetta` binds the same core for hosts building a bare env.
// The `run/continue-after-approval` macro rides this capability's symbols map.
//
// MIGRATION NOTE (W4-H4, docs/working-proposals/symbol-define-static-program-validation.md
// §1/§4.2): this pack's `prelude` was ONE `define-macro` — `run/continue-after-approval` — and
// nothing else. It mechanically decomposes 1:1 (`(define-macro (name . args) body…)` → `(lambda
// args body…)`, §4.2 Pass 1) into the `symbol.defineSyntax` entry below. `macroAttribute:
// "expression"` (§3.4's ternary), NOT `"binder"` (overridable's `define/overridable`, whose
// `name` is a define-target binding position): here BOTH formals are ordinary EXPRESSION space —
// `spec` is spliced as the `approval/await` argument (evaluated at the call site), `result` is
// spliced as the body of an introduced `(lambda () ,result)` thunk. The introduced lambda binds
// nothing (empty formals), so `result`'s free vars are the user program's own bindings and are
// correctly checked against the env when the validator walks them. No `symbol.define` entries
// exist here (one macro, one already-rosetta verb), so Pass 2 (real contracts) touches nothing.

import { EnvCapability, schemeToJs, symbol, z, type SchemeValue } from "@inhuman.tools/arrival";
import type { CallCtx } from "@inhuman.tools/arrival/symbol";

import { runApproval, type OnApprovalRequest, type ResolveApproval } from "./approval.js";

/** @deprecated name kept for arrival-run / chain re-exports — prefer `arrivalApprovalCapability`. */
export const arrivalSuperDefineCapability = new EnvCapability("arrival/superdefine", {
  // Structural validators (not bare `z.custom<T>()`): both sinks are fn seams — assert callable so
  // a malformed host wiring fails loud at lower() rather than at first approval.
  configuration: {
    onApprovalRequest: z.custom<OnApprovalRequest>((v) => typeof v === "function").optional(),
    resolveApproval: z.custom<ResolveApproval>((v) => typeof v === "function").optional(),
  },
  // BUILDER form: the two host sinks arrive via the activation closure. VARIADIC identity input
  // (`z.array(z.value)`, `spec`/`thunk`) with `spec` explicitly `schemeToJs`'d inside the impl —
  // byte-identical to the legacy generic membrane's automatic `schemeToJs` pass (a scheme lambda
  // falls through `schemeToJs` unchanged either way, so `thunk` needs no explicit conversion).
  // `provenance: "pipe"` on the contract preserves the approved value's upstream provenance
  // (see `runApproval`'s doc — a GATE forwards, never mints). Modern spelling of the legacy
  // `pure: true` (which `Contract` never carried — the baked factory ignored it).
  symbols: ({ configuration }) => ({
    "approval/await": symbol.rosetta`approval/await: awaits human approval for a spec before evaluating the thunked result`(
      { input: z.array(z.value), output: [z.value], provenance: "pipe", type: "(spec: unknown, thunk: unknown): unknown" },
      // Boundary assert: runApproval forwards the thunk's value (unknown by design); the
      // z.value contract demands SchemeValue — asserted at the verb table.
      (function (this: CallCtx, spec: unknown, thunk: unknown) {
        return runApproval(
          { onApprovalRequest: configuration.onApprovalRequest, resolveApproval: configuration.resolveApproval },
          schemeToJs(spec as SchemeValue, {}), // boundary narrow — same assert as the impl's `as never`
          thunk,
          this.runCtx,
        );
      }) as never,
    ),
    // The authoring front — a macro that THUNKS `result` (so the irreversible value isn't
    // computed until a human signs off) and lowers to `(approval/await spec (lambda () result))`.
    // Carried on the capability that owns `approval/await`, not in the host preamble.
    "run/continue-after-approval":
      symbol.defineSyntax`run/continue-after-approval: gate a value behind human approval — evaluates spec, then (only once approved) the thunked result — (run/continue-after-approval spec result)`(
        `(lambda (spec result)
           \`(approval/await ,spec (lambda () ,result)))`,
        { macroAttribute: "expression" },
      ),
  }),
});
