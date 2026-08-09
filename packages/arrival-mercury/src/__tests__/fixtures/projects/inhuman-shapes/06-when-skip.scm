;; ════════════════════════════════════════════════════════════════════════
;; SHAPE 06 — LIVE WHEN             body runs sometimes, skipped sometimes
;; ════════════════════════════════════════════════════════════════════════
;; `when` is a one-armed branch: it either runs the body or does nothing. Over
;; (1, -1, 2) it does both — so it is live and leaves a `<>` marker. The skipped iteration
;; (n = -1) produced no card, so the for-each banner reads "3 incoming, 2 kept".
;;
;; Watch for: a ▦ when container, and a "(2 kept)" note on the outer fan-out.

(define spark (require "spark.prompt"))

(define (maybe n)
  (when (> n 0)
    (spark (string-append "w/" (number->string n)) :topic "a small unexpected win")))

(for-each maybe (list 1 -1 2))
