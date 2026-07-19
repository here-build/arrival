;; ════════════════════════════════════════════════════════════════════════
;; SHAPE 03 — LIVE BRANCH        both arms exercised → a `<>` decision MARKER
;; ════════════════════════════════════════════════════════════════════════
;; The test (> n 0) goes BOTH ways across the run (1,-1,2,-2), so the branch
;; actually decided something — it leaves a `<>` marker ("a choice was made
;; here") in the flow, nested inside the for-each. The arms do NOT box; the flow
;; stays the straight line we already draw, just annotated at the decision point.
;;
;; (Contrast 04, where the test is constant and the branch stays seamless.)

(define spark (require "spark.prompt"))

(define (pitch n)
  (if (> n 0)
      (spark (string-append "bright/" (number->string n)) :topic "an optimistic future")
      (spark (string-append "dark/"   (number->string n)) :topic "a cautionary tale")))

(for-each pitch (list 1 -1 2 -2))
