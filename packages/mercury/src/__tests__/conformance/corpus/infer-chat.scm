;; design doc §5 Shape B — infer/chat + the message constructors, no schema.
(define (reaction-of persona)
  (car (infer/chat "echo-model"
    (list (infer/chat/system "be terse")
          (infer/chat/user persona)))))

(reaction-of "a skeptical engineer")
