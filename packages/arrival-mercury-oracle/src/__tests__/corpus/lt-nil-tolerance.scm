(define (int-or-nil flag)
  (if flag -5 '()))
(< (int-or-nil #f) -5)
