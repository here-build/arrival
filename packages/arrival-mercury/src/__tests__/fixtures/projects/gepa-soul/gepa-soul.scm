
(define examples (list
    (dict :input "this app changed my life" :expected "positive")
    (dict :input "it crashes every single time" :expected "negative")
    (dict :input "the update shipped on tuesday" :expected "neutral")
    (dict :input "absolutely love the new design" :expected "positive")
    (dict :input "worst purchase i have ever made" :expected "negative")
    (dict :input "the meeting is at noon" :expected "neutral")
    (dict :input "fantastic support team so helpful" :expected "positive")
    (dict :input "billing double charged me again" :expected "negative")
    (dict :input "documentation lists the endpoints" :expected "neutral")
    (dict :input "genuinely delighted with the results" :expected "positive")))

(define (metric prediction expected) (if (string-ci=? prediction expected) 1 0))

(define (ask instruction input)
  (:label (car (infer/chat "qwen3.5-9b"
                 (list (infer/chat/user (string-append instruction "\n\n" input)))
                 (s/object (s/field/string "label"))
                 (string-append "predict/" instruction "/" input)))))

(define (reflect instruction failures)
  (:instruction (car (infer/chat "qwen3.5-9b"
                       (list (infer/chat/user (string-append
                         "Rewrite it to fix the failures"
                         (if (null? failures) "" (string-append " like: " (:input (car failures))))
                         ". Current instruction: " instruction)))
                       (s/object (s/field/string "instruction"))
                       (string-append "improve/" instruction)))))

(define (evaluate instruction)
  (map (lambda (ex) (metric (ask instruction (:input ex)) (:expected ex))) examples))

(define (assess instruction) (dict :instruction instruction :scores (evaluate instruction)))

(define (failing candidate) (map car (filter (lambda (pair) (zero? (cadr pair))) (map list examples (:scores candidate)))))

(define (mutate candidate) (assess (reflect (:instruction candidate) (failing candidate))))

(define (dominates? a b)
  (and (every >= (:scores a) (:scores b))
       (some  >  (:scores a) (:scores b))))

(define (frontier pool)
  (filter (lambda (c) (not (some (lambda (other) (dominates? other c)) pool))) pool))

(define (iterate step pool n) (if (zero? n) pool (iterate step (step pool) (- n 1))))

(define (generation pool) (frontier (append pool (map mutate pool))))

(define (gepa seed rounds)
  (max-by (lambda (c) (apply + (:scores c)))
          (iterate generation (list (assess seed)) rounds)))

(gepa "Label the text." 4)
