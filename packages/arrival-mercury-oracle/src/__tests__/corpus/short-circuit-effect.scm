(let ((n 0)) (or #t (begin (set! n 999) 'x)) n)
