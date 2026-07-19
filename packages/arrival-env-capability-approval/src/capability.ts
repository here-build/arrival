// arrivalApprovalCapability (alias: arrivalSuperDefineCapability) — human-in-the-loop
// APPROVAL family: `approval/await` + `run/continue-after-approval` authoring macro.
//
// Owns the `mobx` dep (observable request channel + `when`) so arrival-run need not
// define capabilities ad hoc. Every host sink is optional config: absent a sink, the
// verb still evaluates and local-auto-approves.
//
// `approval/await` is a BAKED `symbol.rosetta` calling `runApproval` (./approval.ts).
// `defineApprovalRosetta` binds the same core for hosts building a bare env.
// The `run/continue-after-approval` macro rides this capability's symbols map.
//
// `run/continue-after-approval` lowers to a `symbol.defineSyntax` with `macroAttribute:
// "expression"` — not `"binder"` (the attribute `define/overridable`'s `name` formal takes,
// being a define-target binding position). Both `spec` and `result` here are ordinary
// expression-space formals: `spec` is spliced as the `approval/await` argument (evaluated at
// the call site), `result` is spliced as the body of an introduced `(lambda () ,result)`
// thunk. That lambda binds nothing, so `result`'s free vars are the user program's own
// bindings and are checked against the env like any other reference.

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
  // (`z.array(z.value)`, `spec`/`thunk`) with `spec` explicitly `schemeToJs`'d inside the impl;
  // `thunk` needs no explicit conversion because a scheme lambda falls through `schemeToJs`
  // unchanged. `provenance: "pipe"` on the contract preserves the approved value's upstream
  // provenance (see `runApproval`'s doc — a GATE forwards, never mints) — the `Contract` spelling
  // of what `defineRosetta`'s `pure: true` means elsewhere; `Contract` itself has no `pure` field.
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
