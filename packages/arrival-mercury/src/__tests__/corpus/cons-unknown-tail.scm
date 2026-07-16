(define (num-or-list flag)
  (if flag 7 (list 8 9)))
(cons 'key (num-or-list #t))