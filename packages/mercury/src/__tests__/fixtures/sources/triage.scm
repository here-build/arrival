;; Branching pipeline: classify, then route to one of two DIFFERENT prompts —
;; a shape neither gepa.scm nor characterization.test.ts's toy if/cond corpus
;; covers: real conditional ROUTING between multiple prompt calls, not just a
;; scalar if/cond over plain values.
(define classify (require "classify.prompt"))
(define handle-billing (require "billing.prompt"))
(define handle-general (require "general.prompt"))

(define (route ticket)
  (let ((category (classify (list ticket) :ticket ticket)))
    (if (string-ci=? category "billing")
        (handle-billing (list ticket) :ticket ticket)
        (handle-general (list ticket) :ticket ticket))))

(route "Why was I charged twice this month?")
