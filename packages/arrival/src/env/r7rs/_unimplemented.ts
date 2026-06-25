// @here.build/arrival/r7rs/_unimplemented — manifest of R7RS-small symbols arrival
// does NOT define in this pack. Pure documentation: no EnvCapability, NOT in
// BASE_PACKS. Greppable so an auditor can answer "where did R7RS § X go?".
//
// Three dispositions:
//   "elsewhere"  — implemented, but in another layer (stdlib core / bridge natives).
//   "door"       — deliberately closed by a purity door in core.ts (dynamics +
//                  mutators arrival omits for provenance soundness).
//   "omitted"    — intentionally absent: no IO / ambient / non-deterministic surface
//                  in the inference plane (no construction-site for provenance).
//
// R7RS_TODO is the separate, genuinely-derivable backlog.

export interface R7rsOmission {
  /** R7RS-small section number. */
  readonly section: string;
  /** Why it is not in this pack. */
  readonly reason: "elsewhere" | "door" | "omitted";
  /** Where the real definition / door lives (for "elsewhere" / "door"). */
  readonly at?: string;
  /** Free-form note. */
  readonly note?: string;
}

/**
 * R7RS symbols absent from this derived-syntax pack, categorized.
 * Grep a symbol name here to learn its disposition.
 */
export const R7RS_OMITTED: Readonly<Record<string, R7rsOmission>> = {
  // §6.10 Control features — the value/apply/iteration core lives in the env packs
  // (values/call-with-values in r7rs/binding, apply in r7rs/lists) or, for the ops
  // still blocked on per-op follow-ups, the stdlib global_env.
  values: { section: "6.10", reason: "elsewhere", at: "r7rs/binding" },
  "call-with-values": { section: "6.10", reason: "elsewhere", at: "r7rs/binding" },
  apply: { section: "6.10", reason: "elsewhere", at: "r7rs/lists" },
  map: { section: "6.10", reason: "elsewhere", at: "stdlib core" },
  "for-each": { section: "6.10", reason: "elsewhere", at: "stdlib core" },

  // §6.10 Control features — first-class continuations + dynamics are purity doors.
  "call/cc": { section: "6.10", reason: "door", at: "core.ts (%purity-door)" },
  "call-with-current-continuation": { section: "6.10", reason: "door", at: "core.ts (%purity-door)" },
  "dynamic-wind": { section: "6.10", reason: "door", at: "core.ts (%purity-door)" },
  "make-parameter": { section: "6.10", reason: "door", at: "core.ts (%purity-door)" },
  parameterize: { section: "6.10", reason: "door", at: "core.ts (%purity-door)" },
  delay: { section: "6.10", reason: "door", at: "core.ts (%purity-door)" },
  force: { section: "6.10", reason: "door", at: "core.ts (%purity-door)" },
  "make-promise": { section: "6.10", reason: "door", at: "core.ts (%purity-door)" },
  "delay-force": { section: "6.10", reason: "door", at: "core.ts (%purity-door)" },

  // §6.11 Exceptions — error-object predicates/constructors are native (bridge).
  "error-object?": { section: "6.11", reason: "elsewhere", at: "bridge.ts (native)" },
  "error-object-message": { section: "6.11", reason: "elsewhere", at: "bridge.ts (native)" },
  "error-object-irritants": { section: "6.11", reason: "elsewhere", at: "bridge.ts (native)" },
  "read-error?": { section: "6.11", reason: "elsewhere", at: "bridge.ts (native)" },
  "file-error?": { section: "6.11", reason: "elsewhere", at: "bridge.ts (native)" },
  "%raise": { section: "6.11", reason: "elsewhere", at: "bridge.ts (native)" },

  // §6.13 Ports / IO — intentionally omitted in full: no IO surface in the
  // inference plane (ambient effects, no construction-site for provenance).
  "current-output-port": { section: "6.13", reason: "omitted", note: "no IO surface in the inference plane" },
  "current-input-port": { section: "6.13", reason: "omitted", note: "no IO surface in the inference plane" },
  "current-error-port": { section: "6.13", reason: "omitted", note: "no IO surface in the inference plane" },
  "open-input-string": { section: "6.13", reason: "omitted", note: "no IO surface in the inference plane" },
  "open-output-string": { section: "6.13", reason: "omitted", note: "no IO surface in the inference plane" },
  read: { section: "6.13", reason: "omitted", note: "no IO surface in the inference plane" },
  "read-char": { section: "6.13", reason: "omitted", note: "no IO surface in the inference plane" },
  "write-char": { section: "6.13", reason: "omitted", note: "no IO surface in the inference plane" },
  "write-string": { section: "6.13", reason: "omitted", note: "no IO surface in the inference plane" },
  write: { section: "6.13", reason: "omitted", note: "no IO surface in the inference plane" },
  display: { section: "6.13", reason: "omitted", note: "no IO surface in the inference plane" },
  newline: { section: "6.13", reason: "omitted", note: "no IO surface in the inference plane" },
  "eof-object": { section: "6.13", reason: "omitted", note: "no IO surface in the inference plane" },
  "eof-object?": { section: "6.13", reason: "omitted", note: "no IO surface in the inference plane" },

  // §6.14 System interface — intentionally omitted in full: ambient /
  // non-deterministic, no place in a provenance-grounded inference plane.
  "current-second": { section: "6.14", reason: "omitted", note: "ambient / non-deterministic" },
  "current-jiffy": { section: "6.14", reason: "omitted", note: "ambient / non-deterministic" },
  "jiffies-per-second": { section: "6.14", reason: "omitted", note: "ambient / non-deterministic" },
  "get-environment-variable": { section: "6.14", reason: "omitted", note: "ambient / non-deterministic" },
  "get-environment-variables": { section: "6.14", reason: "omitted", note: "ambient / non-deterministic" },
  "command-line": { section: "6.14", reason: "omitted", note: "ambient / non-deterministic" },
  exit: { section: "6.14", reason: "omitted", note: "ambient / non-deterministic" },
  "emergency-exit": { section: "6.14", reason: "omitted", note: "ambient / non-deterministic" },
};

/**
 * Genuinely-derivable R7RS forms arrival has not yet added.
 */
export const R7RS_TODO: Readonly<Record<string, { readonly section: string; readonly note: string }>> = {
  "define-values": { section: "5.3.3", note: "derivable over call-with-values" },
};
