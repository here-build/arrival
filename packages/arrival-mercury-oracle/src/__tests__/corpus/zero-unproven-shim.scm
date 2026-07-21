(define (num-or-list flag)
  (if flag 0 (list 8 9)))
(zero? (num-or-list #t))
