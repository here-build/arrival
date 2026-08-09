;; ════════════════════════════════════════════════════════════════════════
;; SHAPE 05 — LIVE COND             multi-clause branch, all clauses exercised
;; ════════════════════════════════════════════════════════════════════════
;; Same liveness rule as `if`, for `cond`: the inputs (-1, 0, 1) drive all
;; three clauses; a `<>` marker shows WHERE the clause was chosen. Each tab shows which clause
;; fired (the spark for that bucket).
;;
;; Watch for: a ▦ cond container inside the for-each, one tab per input.

(define spark (require "spark.prompt"))

(define (bucket n)
  (cond ((< n 0) (spark (string-append "lo/" (number->string n)) :topic "recovering from a setback"))
        ((= n 0) (spark "zero" :topic "starting from absolutely nothing"))
        (else    (spark (string-append "hi/" (number->string n)) :topic "riding real momentum"))))

(for-each bucket (list -1 0 1))
