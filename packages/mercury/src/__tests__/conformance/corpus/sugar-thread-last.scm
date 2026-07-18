;; desugar-covered sugar form: `->>` (thread-last) — x becomes the LAST arg of
;; each step. Same steps as sugar-thread-first.scm, deliberately, so the two
;; rows prove the positional difference (14 vs -14), not just "some threading".
(->> 10 (- 3) (* 2))
