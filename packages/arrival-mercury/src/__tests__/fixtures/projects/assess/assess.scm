
(define examples (list
    (dict :input "a" :expected "positive")
    (dict :input "b" :expected "negative")))
(define (metric prediction expected) (if (string-ci=? prediction expected) 1 0))
(define (ask instruction input)
  (:label (car (infer/chat "qwen3.5-9b"
                 (list (infer/chat/user (string-append instruction "\n\n" input)))
                 (s/object (s/field/string "label"))
                 (string-append "predict/" instruction "/" input)))))
(define (evaluate instruction)
  (map (lambda (ex) (metric (ask instruction (:input ex)) (:expected ex))) examples))
(define (assess instruction) (dict :instruction instruction :scores (evaluate instruction)))
(assess "Label the text.")
