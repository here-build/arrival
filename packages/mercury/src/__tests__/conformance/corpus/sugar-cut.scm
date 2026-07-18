;; desugar-covered sugar form: SRFI-26 `cut` (desugar.ts::cutLambda).
(define add-one (cut + <> 1))

(map add-one (list 1 2 3))
