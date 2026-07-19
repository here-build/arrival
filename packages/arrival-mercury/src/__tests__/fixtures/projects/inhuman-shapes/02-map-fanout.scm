;; ════════════════════════════════════════════════════════════════════════
;; SHAPE 02 — MAP FAN-OUT           one SITE, N calls
;; ════════════════════════════════════════════════════════════════════════
;; One spark card, fired once per topic by `map`. The render boxes it as a
;; CONTAINER whose N iterations live on Z-tabs (flip through them), not N flat
;; cards. The cost bar shows the whole distribution on one bar: re-run → all
;; green (cached), edit the prompt → all blue (fresh).
;;
;; Watch for: a single ▦ container, ×3, with three tabs.

(define spark (require "spark.prompt"))

(map (lambda (topic) (spark (string-append "k/" topic) :topic topic))
     (list "better sleep" "deep focus" "slow travel"))
