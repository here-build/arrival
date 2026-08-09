/**
 * The provenance-shaped micro-corpus for the model's red suite. Each program
 * exercises one spine law; all are oracle-legal (they run today through the
 * interpreter) so the dual-plane rows can use the LIVE eager-provenance plane
 * (`deepProvenance`) as ground truth for the static one.
 */

/** Two crossings, one pure chain between them: the minimal anchor→chain→anchor. */
export const TWO_CROSSINGS = `(define response (infer "summarize" "hello world"))
(define verdict (string-append "v:" (car response)))
(infer "classify" verdict)`;

/** Identity/mux chain: pure projection between crossings — unevals to a lens path. */
export const PROJECTION_ONLY = `(define result (infer "extract" "data"))
(infer "consume" (car result))`;

/** The fuse case: control-dependence — the condition's atoms enter the WHY channel. */
export const BRANCH_FUSE = `(define gate (infer "check" "input"))
(define a (infer "path-a" "x"))
(define b (infer "path-b" "y"))
(infer "final" (if (null? gate) (car a) (car b)))`;

/** Dead code: an undemanded pure chain — shaken by the demand graph; crossings pinned. */
export const DEAD_DEFINE = `(define used (infer "live" "u"))
(define unused (string-append "never" "read"))
(infer "out" (car used))`;

/** Fan: one anchor SITE, N runtime instances, parametric transfer (the z-binder). */
export const FAN = `(define xs (list "a" "b" "c"))
(define outs (map (lambda (x) (infer "per-item" x)) xs))
(infer "join" (car outs))`;

/** Computed flow: tier-3 — partial evaluation cannot resolve the callee. */
export const HIGHER_ORDER = `(define f (if (null? (list)) car cdr))
(define src (infer "make" "m"))
(infer "use" (f src))`;

// ── fixtures the audit forced (each names the law it exercises) ──────────

/**
 * SHARED HELPER — the chain-DAG law (design §1, corrected): `both` is a pure
 * value flowing into TWO crossings. Chains SHARE interiors (they do not
 * partition); the helper is never an anchor (it is pure).
 */
export const SHARED_HELPER = `(define both (string-append "p" "q"))
(define a (infer "A" both))
(define b (infer "B" both))
(infer "join" (string-append (car a) (car b)))`;

/**
 * RECURSION with a crossing downstream — L-TOTALITY under recursion, and the
 * per-SITE (not per-call) anchor question.
 */
export const RECURSION = `(define (last-of xs) (if (null? (cdr xs)) (car xs) (last-of (cdr xs))))
(define r (infer "run" (last-of (list "a" "b" "c"))))
(infer "emit" (car r))`;

/**
 * MULTI-SLOT — a crossing whose inputs come from two different anchors: every
 * (anchor, slot) is fed by exactly one chain (L4, the slot-granular reading).
 */
export const MULTI_SLOT = `(define left (infer "L" "l"))
(define right (infer "R" "r"))
(infer "merge" (car left) (car right))`;

/**
 * FAN + DIRECT — the same crossing symbol both inside a fan and called
 * directly: the model must treat them as distinct SITES (distinct anchors),
 * and the dynamic edges of both must land in the static wireMap.
 */
export const FAN_AND_DIRECT = `(define xs (list "a" "b"))
(define d (infer "per-item" "direct"))
(define m (map (lambda (x) (infer "per-item" x)) xs))
(infer "join" (string-append (car d) (car (car m))))`;

/**
 * DYNAMIC KEY — a computed selection key: NOT a static lens path. Must not
 * classify as a tier-1 projection (the `route` operator's territory: the
 * selection is value-driven).
 */
export const DYNAMIC_KEY = `(define d (infer "dict" "data"))
(define k (string-append "k" "1"))
(infer "proj" (assoc k (list (list "k1" "v1") (list "k2" "v2"))))`;

export const ALL = {
  TWO_CROSSINGS,
  PROJECTION_ONLY,
  BRANCH_FUSE,
  DEAD_DEFINE,
  FAN,
  HIGHER_ORDER,
  SHARED_HELPER,
  RECURSION,
  MULTI_SLOT,
  FAN_AND_DIRECT,
  DYNAMIC_KEY,
};
