;; desugar-covered sugar form: `->` (thread-first) — x becomes the FIRST arg of
;; each step. Steps carry their own args so first-vs-last actually differs
;; (a bare-symbol step would thread identically either way).
(-> 10 (- 3) (* 2))
