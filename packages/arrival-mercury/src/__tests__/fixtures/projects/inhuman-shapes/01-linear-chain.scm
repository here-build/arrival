;; ════════════════════════════════════════════════════════════════════════
;; SHAPE 01 — LINEAR CHAIN          a → b → c
;; ════════════════════════════════════════════════════════════════════════
;; Three .prompt cards wired in a line. Each card shows its STRUCTURED fields
;; (idea/energy, idea/improved, summary/count). The wires are FIELD-QUALIFIED:
;; spark's output flows into refine's :idea slot, refine's into digest's :ideas.
;;
;; Watch for: two wires, each labelled with the slot it feeds (:idea, :ideas).

(define spark  (require "spark.prompt"))
(define refine (require "refine.prompt"))
(define digest (require "digest.prompt"))

(let* ((a (spark  "seed"    :topic "a calmer morning routine"))
       (b (refine "sharpen" :idea  (field a "idea")))
       (c (digest "wrap"    :ideas (list b))))
  c)
