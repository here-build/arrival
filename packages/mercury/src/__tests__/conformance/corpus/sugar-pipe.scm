;; desugar-covered sugar form: `pipe` (left-to-right): (pipe f g h) x = h(g(f(x))).
;; Same three functions as sugar-compose.scm, deliberately, so the two rows prove
;; the direction actually differs (20 vs 49), not just "some composition". The
;; immediate-call spelling (formerly a routed-around paren bug) is covered by
;; compose-call-direct.scm since the W3 fix.
(define (double x) (* x 2))
(define (inc x) (+ x 1))
(define (square x) (* x x))
(define pipeline (pipe double inc square))

(pipeline 3)
