;;;;deliberately-ugly-source: inconsistent spacing, redundant nesting, mixed
;;;;idiom — the "would a reviewer wince" row. Still valid, still deterministic;
;;;;the agreement law doesn't care about style, only that compiled ≡ interpreted.
(define   (weird-add   a b)(+    a  b))
(define (nested-mess x)
    (let* ((y (let ((z (* x 2))) (+ z 1)))
             (w      (if (> y 10)
                          (begin (let ((unused 999)) y))
                          (- y 1))))
      (cond ((= w 0) "zero")
            ((> w 100) "big")
            (else (+ w 0)))))

(list (weird-add 1 2)
      (nested-mess 3)
      (nested-mess 10))
