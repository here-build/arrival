(list (some (lambda (x) (if (> x 1) x #f)) (list 0 2))
      (some odd? (list 2 4 6)))
