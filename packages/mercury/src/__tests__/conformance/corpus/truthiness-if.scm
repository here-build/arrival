;; Law T bug cells (design doc Appendix B): only #f is false — 0 and "" are
;; Scheme-truthy. Conditions route through unknown-typed params (the honest-
;; unknown signature fallback) so the strict gate sees `unknown !== false`, the
;; type-legal spelling of the conservative guard (a LITERAL `0 !== false` is
;; TS2367 no-overlap — and literal conditions don't survive real programs).
(define (pick c a b) (if c a b))
(define result (list (pick 0 1 2) (pick "" 1 2) (pick #f 1 2) (pick #t 1 2)))
result
