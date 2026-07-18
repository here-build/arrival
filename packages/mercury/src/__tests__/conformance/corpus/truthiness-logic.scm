;; and/or are VALUE-returning special forms: (and a b) is the first #f operand
;; or the LAST operand's value ((and 0 1) → 1 — 0 is truthy); (or a b) is the
;; FIRST non-#f operand ((or 0 999) → 0); not is exactly the #f test. Params
;; are honest-unknown so the strict gate proves the guarded forms typecheck.
(define (both a b) (and a b))
(define (either a b) (or a b))
(define (negate x) (not x))
(define result
  (list (both 0 1) (both #f 1) (both 1 #f)
        (either 0 999) (either #f 7) (either #f #f)
        (negate 0) (negate "") (negate #f)))
result
