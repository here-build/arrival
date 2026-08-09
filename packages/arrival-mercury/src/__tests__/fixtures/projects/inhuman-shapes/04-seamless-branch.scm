;; ════════════════════════════════════════════════════════════════════════
;; SHAPE 04 — SEAMLESS BRANCH       constant test → only ONE arm ever runs
;; ════════════════════════════════════════════════════════════════════════
;; (if #t …) takes the same route every time, so across THIS run the branch
;; never decided anything — it isn't a decision, it's plumbing. The render
;; flattens it away: you see the spark cards directly, NO `<>` marker.
;;
;; Watch for: just the spark container, no branch wrapper.

(define spark (require "spark.prompt"))

(define (always n)
  (if #t
      (spark (string-append "a/" (number->string n)) :topic "a steady daily habit")
      "never"))

(for-each always (list 1 2 3))
