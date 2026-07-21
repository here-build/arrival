(define (num-or-list flag)
  (if flag 7 (list 8 9)))
(< (num-or-list #t) 10)
