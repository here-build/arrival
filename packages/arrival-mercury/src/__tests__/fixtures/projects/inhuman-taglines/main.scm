;; A plain (infer …) call: pitch the product to the first persona.
;; Runs on open. Re-run replays from cache for $0; edit a prompt → re-mints.

(require "config.scm")     ;; spills (define config/product …) etc.
(define personas (require "personas.json"))  ;; → personas (keyed by id)

(define lead (car (values-of personas)))

;; (infer "<model>" "<prompt>") is content-addressed by [model, prompt].
;; car takes the first (only) completion.
(define pitch
  (car (infer config/model
    (string-append
      "Pitch \"" config/product "\" to " config/audience ".\n"
      "This one is a " (field lead "role") " whose pain is: " (field lead "pain") ".\n"
      "One sentence. Make it land."))))

;; Top-level forms render their value inline at the end of the form.
(string-append "→ pitching " config/product " to " (field lead "name"))
pitch
