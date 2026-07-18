;; invariants/preconditions (R3): `max-by` applied directly to a parameter emits
;; an entry invariant in the compiled artifact (`invariant(scores.length > 0, …)`).
;; This row proves the materialized check is semantically INERT on the defined
;; domain — agreement holds on a non-empty list; the throw path (which the
;; interpreter's own max-by shares: reduce-without-seed errors on empty) stays a
;; unit concern, not a corpus row.
(define (best-of scores) (max-by (lambda (s) s) scores))

(best-of (list 3 1 4))
