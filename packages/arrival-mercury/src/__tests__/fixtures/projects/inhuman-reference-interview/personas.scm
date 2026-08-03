;; ════════════════════════════════════════════════════════════════════════
;; personas.scm — FILE 1: generate a grounded, divergent persona pool
;; ════════════════════════════════════════════════════════════════════════
;;
;; Run this file directly and it returns the persona pool. `(require
;; "personas.scm")` from interview.scm SPILLS its defines — including
;; `data/personas` — into that run (load semantics, like config.scm). So "file 1
;; generates the set, file 2 reuses it as data" is one composed run: requiring
;; this file IS the generation, and the `.inhuman-cache` makes it run for real
;; only once across repeated interview runs. (V asked for `(declare data/personas
;; …)`; arrival-chain has no `declare` form — the faithful translation is this
;; `define` + spill-import.)
;;
;; MODEL WIRING (cheaper env than inhuman-personas — Sonnet replaces Opus
;; everywhere EXCEPT the single market-environment enrichment):
;;   enricher   — Opus    — ONLY the initial landscape (highest-leverage call)
;;   expert     — Sonnet  — profile shaping (the divergence proposer)
;;   roleplay   — owl-alpha — embodies every persona in first person
;;   structurer — qwen    — the only structured output (axis, identity)
;;   pool       — free models, round-robined — persona texture/enrichment

(require "data.scm")   ;; spills data/seed, data/audience, data/features

;; ── shared prelude (spilled into interview.scm too) ───────────────────────
(define n->s number->string)
(define (lines xs) (string-join xs "\n"))

;; stable de-dup preserving first-seen order (reduce is element-first: (x acc))
(define (dedupe xs)
  (reduce (lambda (x acc) (if (member x acc) acc (append acc (list x)))) '() xs))

;; map with the element index threaded in: (f i x)
(define (index-map f xs)
  (define (loop i xs acc)
    (if (null? xs) (reverse acc)
        (loop (+ i 1) (cdr xs) (cons (f i (car xs)) acc))))
  (loop 0 xs '()))

;; remove every member of `to-remove` from `xs` (used by the consolidation loop)
(define (remove-all to-remove xs)
  (filter (lambda (x) (not (member x to-remove))) xs))

;; ── inference units ───────────────────────────────────────────────────────
(define run-landscape (require "landscape.prompt"))
(define run-profile   (require "profile.prompt"))
(define run-axis      (require "extract-axis.prompt"))
(define run-embody    (require "embody.prompt"))
(define run-enrich    (require "enrich.prompt"))
(define run-identity  (require "extract-identity.prompt"))

;; ── project blurb (the stimulus shown to personas, and the search frame) ──
(define (project-blurb features audience)
  (string-append
    "FEATURES:\n"
    (lines (map (lambda (f) (string-append "- " f)) features))
    "\n\nCORE AUDIENCE:\n" audience))

;; ── the divergent loop ────────────────────────────────────────────────────
;;
;; Accumulating fold anchored on the grounded seed. Each round: the expert
;; proposes ONE profile shape maximally far from the seed and every axis seen so
;; far, the structurer compresses it to a short AXIS label (so the loop's memory
;; stays bounded — we feed back 8-word axes, not full prose, and context can't
;; blow up at 50 iterations), the roleplay model embodies it in first person, a
;; round-robined pool model enriches it, and the structurer extracts the clean
;; reusable identity record. Returns the list of {name, jobProfile, persona}.
(define (grow-personas landscape iterations models blurb)
  (define roleplay   (:roleplay models))
  (define expert     (:expert models))
  (define structurer (:structurer models))
  (define pool       (:pool models))
  (define (loop i axes acc)
    (if (>= i iterations)
        (reverse acc)
        (let* ((known    (lines axes))
               (profile  (run-profile (string-append "profile/" (n->s i))
                           :meta (dict :model expert)
                           :blurb blurb :landscape landscape :known known))
               (axis     (:axis (run-axis (string-append "axis/" (n->s i))
                           :meta (dict :model structurer) :profile profile)))
               (persona  (run-embody (string-append "persona/" (n->s i))
                           :meta (dict :model roleplay) :profile profile))
               ;; round-robin the ideation pool — the model is the loop's, so it
               ;; can ONLY come from the call site (the case `:meta` exists for).
               (model    (list-ref pool (modulo i (length pool))))
               (enriched (run-enrich (string-append "enrich/" (n->s i))
                           :meta (dict :model model)
                           :profile profile :persona persona))
               (id       (run-identity (string-append "ident/" (n->s i))
                           :meta (dict :model structurer) :persona enriched)))
          ;; the seed anchors divergence (first `known` entry) but is not output.
          (loop (+ i 1) (cons axis axes) (cons id acc)))))
  (loop 0 (list data/seed) '()))

;; ── DECLARED INIT PARAMS (this becomes the API request body later) ────────
(define ref/models
  (dict
    :enricher   "claude-opus-4-8"          ;; the one Opus call (landscape)
    :expert     "claude-sonnet-4-6"        ;; divergence proposer
    :roleplay   "openrouter/owl-alpha"     ;; best impersonator
    :structurer "qwen/qwen3.6-35b-a3b"     ;; the mini model
    :pool       (list
      "moonshotai/kimi-k2.6:free"
      "gpt-oss-120b"
      "liquid/lfm-2.5-1.2b-thinking:free")))

(define ref/iterations 50)
(define ref/blurb (project-blurb data/features data/audience))

;; Stage 0 — the ONE Opus call: enrich the initial market environment.
(define ref/landscape
  (run-landscape "landscape"
    :meta (dict :model (:enricher ref/models))
    :blurb ref/blurb :seed data/seed))

;; Stage 1 — diverge into 50 grounded personas. THIS is V's `data/personas`.
(define data/personas
  (grow-personas ref/landscape ref/iterations ref/models ref/blurb))

;; running this file standalone returns the pool
data/personas
