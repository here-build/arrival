/**
 * The provenance-shaped micro-corpus for the model's red suite. Each program
 * exercises one spine law; all are oracle-legal (run today through the
 * interpreter) so the dual-plane tests can use the live tracer as ground
 * truth once wired.
 */

/** Two crossings, one pure chain between them: the minimal anchor→chain→anchor. */
export const TWO_CROSSINGS = `(define response (infer "summarize" "hello world"))
(define verdict (string-append "v:" (car response)))
(infer "classify" verdict)`;

/** Identity/mux chain: pure projection between crossings — unevals to a lens path. */
export const PROJECTION_ONLY = `(define result (infer "extract" "data"))
(infer "consume" (car result))`;

/** The fuse case: control-dependence — condition's atoms enter the WHY channel. */
export const BRANCH_FUSE = `(define gate (infer "check" "input"))
(define a (infer "path-a" "x"))
(define b (infer "path-b" "y"))
(infer "final" (if (null? gate) (car a) (car b)))`;

/** Dead code: an undemanded crossing — shaken by the demand graph, effects pinned. */
export const DEAD_DEFINE = `(define used (infer "live" "u"))
(define unused (string-append "never" "read"))
(infer "out" (car used))`;

/** Fan: one anchor site, N instances, parametric transfer (z-binder). */
export const FAN = `(define xs (list "a" "b" "c"))
(define outs (map (lambda (x) (infer "per-item" x)) xs))
(infer "join" (car outs))`;

/** Computed flow: tier-3 — partial evaluation cannot resolve the callee. */
export const HIGHER_ORDER = `(define f (if (null? (list)) car cdr))
(define src (infer "make" "m"))
(infer "use" (f src))`;

export const ALL = { TWO_CROSSINGS, PROJECTION_ONLY, BRANCH_FUSE, DEAD_DEFINE, FAN, HIGHER_ORDER };
