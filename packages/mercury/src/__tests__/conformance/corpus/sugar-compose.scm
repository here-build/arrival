;; desugar-covered sugar form: `compose` (right-to-left): (compose f g h) x = f(g(h(x))).
;; This row binds the pipeline to a name before calling — the define-then-call
;; spelling `composeLambda`'s own doc calls the common use. The IMMEDIATE-call
;; spelling `((compose …) x)` — once a W2-flagged paren bug, routed around here —
;; was fixed in W3 and has its own row: compose-call-direct.scm.
(define (double x) (* x 2))
(define (inc x) (+ x 1))
(define (square x) (* x x))
(define pipeline (compose double inc square))

(pipeline 3)
