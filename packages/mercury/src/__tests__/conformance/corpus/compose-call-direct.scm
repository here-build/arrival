;; The W2-flagged compiler bug, FIXED in W3: immediate invocation of a `compose`
;; result. Before the fix, `((compose f g) x)` lowered to `(it) => f(g(it))(x)` —
;; an unparenthesized arrow in call-head position, i.e. a bare, never-invoked
;; function literal. The callee is parenthesized now, so this row exercises the
;; direct shape W2 routed around (see sugar-compose.scm for the define-then-call
;; spelling). Same three functions, same expected value (20).
(define (double x) (* x 2))
(define (inc x) (+ x 1))
(define (square x) (* x x))

((compose double inc square) 3)
