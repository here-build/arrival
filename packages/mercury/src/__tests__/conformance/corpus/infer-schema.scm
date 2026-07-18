;; design doc §5 Shape B, schema variant — resolves the W2 "decoded object vs
;; JSON string" flag (see ../schema-infer-probe.test.ts): both runtimes must
;; agree the echoed value is a materialized object, not a JSON string.
(define (triage ticket)
  (car (infer "echo-model" ticket '(s/object :severity (s/enum "low" "high") :summary s/string))))

(triage "the button is broken")
