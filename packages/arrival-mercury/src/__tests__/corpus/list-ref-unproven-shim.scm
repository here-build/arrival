(define (num-or-list flag)
  (if flag 7 (list 10 20 30)))
(list-ref (num-or-list #f) 1)
