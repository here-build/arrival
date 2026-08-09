;; ════════════════════════════════════════════════════════════════════════
;; SHAPE 07 — BRANCH INSIDE MAP     fan-out of a branching body
;; ════════════════════════════════════════════════════════════════════════
;; The lambda body is itself a live branch, so each map iteration's tab holds
;; an `if` container. Nesting is real: ▦ map → tab → ▦ if → spark card.
;;
;; Watch for: a `<>` decision marker inside each Z-tab of the map.

(define spark (require "spark.prompt"))

(map (lambda (n)
       (if (> n 0)
           (spark (string-append "p/" (number->string n)) :topic "a bright angle")
           (spark (string-append "n/" (number->string n)) :topic "a wary angle")))
     (list 1 -1 2))
