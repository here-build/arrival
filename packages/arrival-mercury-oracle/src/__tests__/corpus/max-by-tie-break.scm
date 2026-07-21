(list (max-by (lambda (x) x) (list 3 1 4 1 5 9 2 6))
      (max-by car (list (list 5 "first") (list 5 "second") (list 2 "third"))))
