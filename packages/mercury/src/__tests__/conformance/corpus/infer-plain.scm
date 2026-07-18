;; design doc §5 Shape A — the ubiquitous (car (infer ...)) scalar-fold idiom.
;; `infer` resolves through the shared echo oracle on BOTH runtimes (see
;; support/echo-infer.ts) — deterministic, no network, no clock.
(define (tagline product)
  (car (infer "echo-model" (string-append "One tagline for " product))))

(tagline "widget")
