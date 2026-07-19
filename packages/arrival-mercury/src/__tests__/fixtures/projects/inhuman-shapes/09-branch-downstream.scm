;; ════════════════════════════════════════════════════════════════════════
;; SHAPE 09 — BRANCH CONSUMED DOWNSTREAM   wire crosses the branch boundary
;; ════════════════════════════════════════════════════════════════════════
;; The branch's RESULT is fed into digest's :ideas — the spark lives in
;; ARGUMENT position, inside the live `if`. The render HOISTS that `if` out in
;; front of digest (as a preceding sibling) so the :ideas wire lands on the
;; actually-rendered spark card instead of dangling. Each map tab shows:
;;   ▦ if → spark   then   digest, wired :ideas.
;;
;; Watch for: the `<>` decision marker hoisted BEFORE digest, with the wire connected.

(define spark  (require "spark.prompt"))
(define digest (require "digest.prompt"))

(define (pick n)
  (if (> n 0)
      (spark (string-append "p/" (number->string n)) :topic "a bold idea")
      (spark (string-append "n/" (number->string n)) :topic "a quiet idea")))

(map (lambda (n) (digest (string-append "d/" (number->string n)) :ideas (list (pick n))))
     (list 1 -1))
