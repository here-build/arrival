;; COPY-AS-CHUNK — gate1-corpus manifest entry (verbatim copy for site-density
;; measurement). Source: inhuman/examples/ai-winter-thawed/scm/ebl-investigation.scm.
;;
;; Selection rationale: the ONLY candidate found across every scouted directory
;; (mercury fixtures, the gepa examples, ai-winter-thawed, arrival-sugarcoat demos,
;; arrival-run tests) carrying a literal top-level `(infer …)` call inside a real,
;; runnable program rather than a one-line test probe — satisfies the manifest's
;; "≥1 infer usage across the corpus" criterion on its own.

;; ebl-investigation.scm — ONE worked investigation over image A.
;;
;; Reads the device registry at the membrane, projects fields, filters on a PURE predicate
;; (privileged port < 1024 owned by a non-root user = a misconfiguration), and returns the name
;; of the first offender. The whole derivation is a Galois slice the EBL demo lifts into a
;; reusable, sound detector — the membrane read becomes the hole, the predicate stays.

(define raw (car (infer "fast" "read devices")))
(define devices (json/parse raw))
(define privileged
  (filter (lambda (d) (and (< (:port d) 1024)
                           (not (equal? (:owner d) "root"))))
          devices))
(define offenders (map (lambda (d) (:name d)) privileged))
offenders
