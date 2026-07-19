;; ════════════════════════════════════════════════════════════════════════
;; Synthetic-persona generation pipeline (inhuman scheme)
;; ════════════════════════════════════════════════════════════════════════
;;
;; A divergent persona generator: a "markets expert" pushes the search OUTWARD
;; (max-far profile shapes), a "roleplay" model embodies each shape in first
;; person, an ideation-pool model adds personal texture, and a "cheap structurer"
;; is the ONLY model that ever produces structured output — everything else is
;; direct speech.
;;
;; Every inference is a `.prompt` file (a sealed dotprompt unit: the system +
;; user template and, for the structurer, the output schema). pipeline.scm is now
;; PURE ORCHESTRATION — no prompt strings, no schema blocks. Each `.prompt` is the
;; prompt INTENT; the MODEL is materialization, supplied per call as init-param
;; wiring via `:meta (dict :model …)`. So the same units run against any model
;; configuration, and the pool model can be round-robined per iteration — which a
;; baked frontmatter `model:` could never express.
;;
;; The whole flow is one function, `pipeline`, whose parameters are the INIT
;; PARAMS this will be exposed with when it becomes an API (the project to study
;; and the model wiring). The bottom of the file calls it with concrete declared
;; values — that call site is the only thing that changes per run; later it
;; becomes the API's request body. Context is threaded explicitly through every
;; stage helper (no globals) so the function is self-contained and reentrant.
;;
;; Roles (plain model-name strings, bound to endpoints in inhuman.config.json):
;;   roleplay    — embodies a persona, speaks in first person   (openrouter/owl-alpha)
;;   expert      — markets analyst, pushes the search outward    (Opus)
;;   structurer  — extraction-only, the sole structured output   (local qwen)
;;   pool        — ideation models, round-robined for enrichment  (list)
;;
;; Run:  inhuman run examples/inhuman-personas   (entry = pipeline.scm)

;; ── tiny prelude ─────────────────────────────────────────────────────────
(define n->s number->string)
(define (lines xs) (join "\n" xs))

;; stable de-dup preserving first-seen order (reduce here is element-first: (x acc))
(define (dedupe xs)
  (reduce (lambda (x acc) (if (member x acc) acc (append acc (list x)))) '() xs))

;; map with the element index threaded in: (f i x)
(define (index-map f xs)
  (define (loop i xs acc)
    (if (null? xs) (reverse acc)
        (loop (+ i 1) (cdr xs) (cons (f i (car xs)) acc))))
  (loop 0 xs '()))

;; ── the inference units (.prompt = sealed dotprompt) ──────────────────────
;;
;; Each `(require "x.prompt")` returns a proc `(run-x cache-key :meta cfg :var v …)`
;; that renders its template against the kwargs and infers as ONE traced node.
;; The first positional is the cache key (provenance/dedup identity). `:meta`
;; carries the model (and any future temp/maxTokens); the rest are template holes.
(define run-landscape   (require "landscape.prompt"))
(define run-profile     (require "profile.prompt"))
(define run-seed        (require "seed.prompt"))
(define run-embody      (require "embody.prompt"))
(define run-enrich      (require "enrich.prompt"))
(define run-identity    (require "extract-identity.prompt"))
(define run-hypothesis  (require "hypothesis.prompt"))
(define run-aspects     (require "impersonate-aspects.prompt"))
(define run-competitors (require "impersonate-competitors.prompt"))
(define run-list        (require "extract-list.prompt"))

;; ── project blurb ────────────────────────────────────────────────────────
(define (project-blurb project)
  (string-append
    "FEATURES:\n"
    (lines (map (lambda (f) (string-append "- " f)) (:features project)))
    "\n\nCORE AUDIENCE:\n" (:audience project)))

;; ── Stage 1: the divergent loop ──────────────────────────────────────────
;;
;; Accumulating fold. Each round: the expert proposes ONE profile shape maximally
;; far from everything seen so far (seed + accumulated), the roleplay model
;; embodies it, and a round-robined pool model enriches it. Returns the list of
;; enriched first-person persona texts, in generation order. An unstructured
;; `.prompt` returns its text directly — no `car` (that was the raw `infer/chat`
;; list-wrap; the sealed unit hands back the value).
(define (grow-personas landscape seed iterations roleplay expert pool blurb)
  (define (loop i acc)
    (if (>= i iterations)
        (reverse acc)
        (let* ((known    (lines (cons seed (reverse acc))))
               (profile  (run-profile (string-append "profile/" (n->s i))
                           :meta (dict :model expert)
                           :blurb blurb :landscape landscape :known known))
               (persona  (run-embody (string-append "persona/" (n->s i))
                           :meta (dict :model roleplay)
                           :profile profile))
               ;; round-robin the ideation pool — the model is the loop's, so it
               ;; can ONLY come from the call site (the case `:meta` exists for).
               (model    (list-ref pool (modulo i (length pool))))
               (enriched (run-enrich (string-append "enrich/" (n->s i))
                           :meta (dict :model model)
                           :profile profile :persona persona)))
          (loop (+ i 1) (cons enriched acc)))))
  (loop 0 '()))

;; ── Stage 2: process one persona ─────────────────────────────────────────
;;
;; structurer extracts identity (the only place we go structured — `run-identity`
;; / `run-list` return dicts, read with `:field`), the expert hypothesizes what
;; matters (direct speech), the persona speaks for itself twice (direct speech),
;; and finally the structurer turns each raw answer into a flat list. Both raw and
;; listified forms are kept in the output.
(define (process-persona i persona structurer expert roleplay blurb)
  (let* ((k (lambda (stage) (string-append stage "/" (n->s i))))

         ;; structurer → identity (structured)
         (id            (run-identity (k "ident") :meta (dict :model structurer) :persona persona))
         (name          (:name id))
         (job-profile   (:jobProfile id))
         (clean-persona (:persona id))

         ;; expert hypothesis (direct speech) — over the full enriched persona
         (hyp-raw (run-hypothesis (k "hyp") :meta (dict :model expert)
                    :blurb blurb :persona persona))

         ;; persona speaks — two asks, in character (direct speech) over the clean persona
         (aspects-raw (run-aspects (k "aspects") :meta (dict :model roleplay)
                        :blurb blurb :persona clean-persona))
         (compet-raw  (run-competitors (k "compet") :meta (dict :model roleplay)
                        :blurb blurb :persona clean-persona))

         ;; structurer → flat lists (structured) — one unit, varying instruction
         (hyp-list (:items (run-list (k "hyp-x") :meta (dict :model structurer)
                     :instruction "List the distinct important aspects mentioned here:"
                     :text hyp-raw)))
         (aspects-list (:items (run-list (k "aspects-x") :meta (dict :model structurer)
                         :instruction "List the distinct things this person says matter to them:"
                         :text aspects-raw)))
         (compet-list (:items (run-list (k "compet-x") :meta (dict :model structurer)
                        :instruction "List ONLY the product names mentioned here, one per item:"
                        :text compet-raw))))

    ;; Output record. Keyword keys where the name is an identifier; "job profile"
    ;; keeps a string key — it has a space, which a keyword can't represent.
    (dict
      :name                                  name
      "job profile"                          job-profile
      :persona                               clean-persona
      :expertHypothesisImportantAspects      hyp-list
      :expertHypothesisImportantAspectsRaw   hyp-raw
      :importantAspects                      aspects-list
      :importantAspectsRaw                   aspects-raw
      :competitorsNamed                      compet-list
      :competitorsNamedRaw                   compet-raw)))

;; ── Stage 3: aggregate competitor mentions ───────────────────────────────
(define (tally-competitors records)
  (let* ((all  (apply append (map (lambda (r) (:competitorsNamed r)) records)))
         (uniq (dedupe all)))
    (map (lambda (name)
           (dict :name name
                 :mentionedCount (count-if (lambda (x) (equal? x name)) all)))
         uniq)))

;; ── the pipeline (init params = future API request body) ─────────────────
(define (pipeline project models iterations)
  (define roleplay   (:roleplay models))
  (define expert     (:expert models))
  (define structurer (:structurer models))
  (define pool       (:pool models))
  (define blurb      (project-blurb project))

  ;; Stage 0 — set the field. Expert sketches the widest credible market;
  ;; roleplay grounds us with one beloved core-audience persona as the seed.
  (define landscape (run-landscape "landscape" :meta (dict :model expert) :blurb blurb))
  (define seed      (run-seed "seed" :meta (dict :model roleplay) :blurb blurb))

  ;; Stage 1 — diverge.
  (define raw-personas (grow-personas landscape seed iterations roleplay expert pool blurb))

  ;; Stage 2 — process each.
  (define records
    (index-map (lambda (i p) (process-persona i p structurer expert roleplay blurb))
               raw-personas))

  ;; Stage 3 — assemble the output.
  (dict :personas    records
        :competitors (tally-competitors records)))

;; ── DECLARED INIT PARAMS (this call becomes the API request later) ────────
(pipeline
  ;; project — features + the CORE (not general) audience
  (dict
    :features (list
      "Visual builder for real React / Next.js web apps"
      "You own the generated code — no lock-in"
      "Optional Web3: wallet connect, on-chain reads/writes"
      "One-click deploy to your own hosting")
    :audience
      (string-append
        "Indie developers and tiny agencies who can code but want to ship client "
        "and side-project web apps fast, without hand-writing boilerplate — and who "
        "care about owning the output."))

  ;; models — plain names; inhuman.config.json binds each to an endpoint
  (dict
    :roleplay   "openrouter/owl-alpha"
    :expert     "claude-opus-4-8"
    :structurer "qwen/qwen3.6-35b-a3b"
    :pool       (list                   ;; OpenRouter free ideation pool, round-robined
      "moonshotai/kimi-k2.6:free"
      "gpt-oss-120b"
      "liquid/lfm-2.5-1.2b-thinking:free"))

  ;; iterations — small for a test run
  10)
