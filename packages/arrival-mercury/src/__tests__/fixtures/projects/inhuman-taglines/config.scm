;; Config as code — one (define/overridable config/<name> type default) per setting.
;; The runnable cells `(require "config.scm")` to spill these into scope; the form lens
;; renders each overridable as a typed input (the knobs live in one place, out of the
;; program bodies). Edit a field → the next ▶ runs with your value, the bytes untouched.

(define/overridable config/product (s/string) "Here.build")
(define/overridable config/audience (s/string) "people who build web apps")

;; The model id is the content-addressed cache key AND tells the runner which backend
;; serves the call. Open value — set it to whatever your runner has wired (hence
;; (s/string), not a fixed enum that would lock you out of your own model).
(define/overridable config/model (s/string) "qwen3.5-9b")

;; The system prompt as config — tuned freely without touching the program body.
(define/overridable config/voice
  (s/string)
  "You are a blunt early adopter. No hype. Two sentences, max.")
