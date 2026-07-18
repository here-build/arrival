;; The no-infer boring-parts floor (design doc §8/review-corpus): plain recursive
;; logic, nothing exotic, no LLM in sight. The compiler must get the ordinary case
;; byte-for-byte right before any of the interesting axis-a folds are trusted.
(define (factorial n) (if (<= n 1) 1 (* n (factorial (- n 1)))))
(define (sum-of-squares xs) (apply + (map (lambda (x) (* x x)) xs)))

(list (factorial 6) (sum-of-squares (list 1 2 3 4 5)))
