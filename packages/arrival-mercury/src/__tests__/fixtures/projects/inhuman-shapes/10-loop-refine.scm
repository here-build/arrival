;; ════════════════════════════════════════════════════════════════════════
;; SHAPE 10 — LOOP (SELF-RECURSION)   one container, iterations on Z-tabs
;; ════════════════════════════════════════════════════════════════════════
;; `loop` calls itself in tail position to refine the idea three times. The
;; render detects the self-recursion and peels it into ONE fan-out container
;; whose tabs are the successive passes — NOT three separate cards. The inner
;; `if` is loop-CONTROL (recurse vs stop), already embodied by the container's
;; iteration count, so it does NOT double-draw as a branch box.
;;
;; Watch for: a single ▦ loop container, three tabs, NO inner `if` box.

(define spark  (require "spark.prompt"))
(define refine (require "refine.prompt"))

(define (loop idea round)
  (if (>= round 3)
      idea
      (loop (refine (string-append "r/" (number->string round)) :idea (field idea "idea"))
            (+ round 1))))

(loop (spark "seed" :topic "a tool that teaches itself") 0)
