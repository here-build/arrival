;; One (infer …) SITE, N calls — (map …) fires it once per persona. The cost
;; bar above the infer shows the whole distribution (cached vs fresh) on one
;; bar: re-run → all green (saved); edit the template → all blue (fresh).

(require "config.scm")
(define personas (require "personas.json"))
(define reaction (require "reaction.hbs"))   ;; .hbs evaluates to a callable lambda

;; (reaction "product" … "role" … "pain" …) fills the handlebars template by key.
(define (reaction-of persona)
  (car (infer/chat config/model
    (list (infer/chat/system config/voice)
          (infer/chat/user
            (reaction "product" config/product
                      "role"    (field persona "role")
                      "pain"    (field persona "pain")))))))

(map reaction-of (values-of personas))
