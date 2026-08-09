;; ════════════════════════════════════════════════════════════════════════
;; SHAPE 08 — ARRAY-PACKED FIELD    two producers → one :ideas slot
;; ════════════════════════════════════════════════════════════════════════
;; Both sparks get packed into a single list and handed to digest's :ideas.
;; Per-element provenance survives the packing, so EACH spark stays wired to
;; `ideas` specifically — not "the digest block in general". This is the sound
;; field-attribution: two wires, both labelled :ideas, landing on one card.
;;
;; Watch for: two spark cards → digest, both wires reading :ideas.

(define spark  (require "spark.prompt"))
(define digest (require "digest.prompt"))

(let* ((a (spark "ka" :topic "morning rituals"))
       (b (spark "kb" :topic "evening rituals")))
  (digest "kr" :ideas (list a b)))
