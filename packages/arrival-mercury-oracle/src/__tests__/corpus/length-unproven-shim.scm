(define (list-or-string flag)
  (if flag (list 1 2 3) "abc"))
(length (list-or-string #t))
