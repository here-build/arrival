;; control/self-tail-loop: a named let whose recursive calls are ALL tail calls
;; lowers to `while (true)` in the run register (the seam-8 TCO obligation —
;; unbounded iteration without stack growth). This row is the agreement proof
;; that the rewrite preserves semantics: same accumulator walk on both runtimes.
(define (sum-to n)
  (let go ((i 0) (acc 0))
    (if (< i n) (go (+ i 1) (+ acc i)) acc)))

(sum-to 10)
