;; COPY-AS-CHUNK — gate1-corpus manifest entry (verbatim copy for site-density
;; measurement; constitution §9's committed corpus, NOT the compiler's own code —
;; copied here so the corpus is self-contained inside this package, per
;; env-quasi-packages' "never shared imports" spirit applied to fixtures).
;; Source: inhuman/examples/inhuman-reference/interview.scm (unmodified below the
;; rule; `(require "personas.scm")` at the top is a real cross-file dependency of
;; the ORIGINAL example — classify() treats `Require` as an inert leaf node, so
;; the referenced file need not exist for this corpus entry to classify/measure
;; cleanly, same as every other manifest entry's own `require`s).
;;
;; Selection rationale (R5a manifest widening): a stateless interview → consolidate
;; → audit pipeline — 10 car/if sites (4 car, 6 if), ALL clean under today's rules;
;; measured via gate1/measure.ts's own `measureProgram`, not eyeballed. Chosen
;; alongside inhuman-custdev-best-tagline.scm and inhuman-geo.scm to dilute the
;; original manifest's 92%-in-one-file concentration with real, differently-shaped
;; programs rather than synthetic filler.
;;
;; ════════════════════════════════════════════════════════════════════════
;; interview.scm — FILE 2: interview the pool, consolidate dealbreakers, audit
;; ════════════════════════════════════════════════════════════════════════
;;
;; Reuses file 1's output as data: `(require "personas.scm")` spills
;; `data/personas` (plus the prelude helpers and `ref/models`/`ref/blurb`) into
;; this run. The `.inhuman-cache` means the 50-persona generation runs for real
;; only once — every later interview run replays it from cache.
;;
;; FLOW:
;;   A. interview each persona — TWO SEPARATE stateless queries (features,
;;      dealbreakers), owl-alpha roleplay. Stateless = frozen persona prefix, one
;;      question, no accumulation → drift impossible by construction.
;;   B. consolidate the pooled dealbreakers under the mini model (qwen),
;;      loop-until-dry: name the most-recurring problem → gather its variants →
;;      set aside {name, forms, count} → repeat on what's left.
;;   C. audit (Sonnet, separate from the model that clustered): misattribution
;;      count + the specific mistakes, structured, NO recovery strategy.
;;   D. assemble — and if the audit found misattribution, flip the CANARY: the
;;      output record carries `__canary__`, which the chart renders as a yellow
;;      warning block and console.warns. (Render-recognized value shape, not a
;;      runtime node kind — no model/runtime change, derive-at-render.)

(require "personas.scm")   ;; spills data/personas, ref/models, ref/blurb, prelude

;; ── inference units ───────────────────────────────────────────────────────
(define run-features     (require "interview-features.prompt"))
(define run-dealbreakers (require "interview-dealbreakers.prompt"))
(define run-explain      (require "interview-explain.prompt"))
(define run-describe     (require "describe-dealbreaker.prompt"))
(define run-list         (require "extract-list.prompt"))
(define run-cons-most    (require "consolidate-most.prompt"))
(define run-cons-var     (require "consolidate-variants.prompt"))
(define run-disc-case    (require "discriminate-case.prompt"))
(define run-synth        (require "synthesize-category.prompt"))
(define run-audit        (require "audit.prompt"))

(define roleplay   (:roleplay ref/models))
(define structurer (:structurer ref/models))
(define auditor    "claude-sonnet-4-6")   ;; the audit runs on Sonnet

;; ── Stage A: interview one persona — two SEPARATE stateless queries ───────
(define (interview-one p)
  (let*
    ((nm (:name p))
      (k (lambda (s) (string-apptend s "/" nm)))
      (persona (:persona p))
      (feat-raw (run-features (k "feat") :meta (dict :model roleplay) :blurb ref/blurb :persona persona))
      (deal-raw (run-dealbreakers (k "deal") :meta (dict :model roleplay) :blurb ref/blurb :persona persona))
      (feat-list
        (:items
          (run-list (k "feat-x")
            :meta
            (dict :model structurer)
            :instruction
            "List the distinct features this person says would matter most to them, one per item:"
            :text
            feat-raw)))
      (deal-list
        (:items
          (run-list (k "deal-x")
            :meta
            (dict :model structurer)
            :instruction
            "List the distinct missing things this person calls dealbreakers, one per item:"
            :text
            deal-raw)))
      (deal-enriched
        (map
          (lambda (db)
            (let*
              ((why (run-explain (string-append (k "deal-why") "/" db) :meta (dict :model roleplay) :persona persona :blurb ref/blurb :prior deal-raw :dealbreaker db))
                (desc
                  (:description
                    (run-describe (string-append (k "deal-desc") "/" db) :meta (dict :model structurer) :why why))))
              (dict :one-liner db :description desc :why why)))
          deal-list)))
    (dict :name (:name p) :features feat-list :dealbreakers deal-list :dealbreakers-enriched deal-enriched)))

(define interviews (map interview-one data/personas))

;; pooled dealbreakers across everyone — the input to consolidation
(define pooled-dealbreakers
  (apply append (map (lambda (r) (:dealbreakers r)) interviews)))

;; pooled ENRICHED dealbreakers — each {one-liner, description, why}, context-complete
;; from the persona who holds the intent. This is what the reshaped consolidation reads.
(define pooled-enriched
  (apply append (map (lambda (r) (:dealbreakers-enriched r)) interviews)))

;; the consolidator's working universe: the derived one-line descriptions. (The
;; per-case discriminator pulls each item's why-prose back via `why-of`.)
(define pooled-descriptions
  (map (lambda (r) (:description r)) pooled-enriched))

;; ── Stage B: consolidation loop (qwen), loop-until-dry ────────────────────
;;
;; ASSIGNMENT-TO-EXEMPLARS over the enriched records (V's design). The old loop
;; gated everything on one fuzzy NAME and trusted a single batch discriminator;
;; the mega-bucket formed because `cons-most`'s "most-recurring problem" framing
;; rewards generality and nothing per-item pushed back hard enough. The reshape
;; treats one round as an ATOMIC CHAIN and moves the cleaning to per-case fan-out:
;;
;;   1. consolidator (cons-most → cons-var) names the most-recurring problem and
;;      GATHERS its candidates from the DESCRIPTIONS only. Over-gathering is now
;;      EXPECTED — the candidate list is deliberately redundant; precision is the
;;      next step's job, not this one's.
;;   2. PARALLEL per-case discriminators — one independent verdict per candidate,
;;      each reading that candidate's own description + why-prose (context the
;;      consolidator never saw). `(map …)` runs the body in parallel, so this is
;;      true fan-out, not a batch "filter this list". Each verdict carries a
;;      REASON: "why it still belongs" (kept) or "why it does not" (ejected).
;;   3. synthesize — both reason-lists sharpen the fuzzy name into a durable
;;      {title, description}: kept-reasons fix the positive boundary, eject-reasons
;;      the negative one.
;; Ejected candidates return to the pool FOR FREE (`rest = remaining − kept`) and
;; recluster next round. Progress guarantee unchanged: if nothing is kept we
;; force-keep the first remaining item as a singleton, so the loop can never spin.
(define (consolidate records)
  ;; description → why-prose (first occurrence wins; a repeated description is the
  ;; same problem, so either persona's why is representative for the discriminator).
  (define (why-of desc)
    (define (find rs)
      (if (null? rs) ""
          (if (equal? (:description (car rs)) desc) (:why (car rs)) (find (cdr rs)))))
    (find records))
  (define (loop remaining clusters guard)
    (if (or (null? remaining) (>= guard 60))
        (reverse clusters)
        (let* ((most (:name (run-cons-most (string-append "cons-most/" (n->s guard))
                       :meta (dict :model structurer) :items (lines remaining))))
               (variants (:items (run-cons-var (string-append "cons-var/" (n->s guard))
                           :meta (dict :model structurer) :name most :items (lines remaining))))
               (matched  (filter (lambda (x) (member x remaining)) variants))
               ;; PARALLEL per-case discrimination — one verdict per candidate, each
               ;; reading its OWN description + why-prose. Native `map` runs the bodies
               ;; concurrently (promise_all); `index-map` would serialize them. Keyed by
               ;; the description, so identical descriptions correctly share one verdict.
               (verdicts (map
                           (lambda (d)
                             (let ((v (run-disc-case (string-append "disc/" (n->s guard) "/" d)
                                        :meta (dict :model structurer)
                                        :name most :description d :why (why-of d))))
                               (dict :desc d :belongs (:belongs v) :reason (:reason v))))
                           matched))
               (kept-v    (filter (lambda (v) (:belongs v)) verdicts))
               (ejected-v (filter (lambda (v) (not (:belongs v))) verdicts))
               (kept      (map (lambda (v) (:desc v)) kept-v))
               ;; force-keep ≥1 so `remaining` strictly shrinks even if all ejected
               (matched*  (if (null? kept) (list (car remaining)) kept))
               (line-of   (lambda (v) (string-append (:desc v) " — " (:reason v))))
               ;; synthesize a sharp {title, description} from BOTH reason-lists.
               ;; (Degenerate forced-singleton round: skip synth, the name is the title.)
               (synth     (if (null? kept-v)
                              (dict :title most :description most)
                              (run-synth (string-append "synth/" (n->s guard))
                                :meta (dict :model structurer)
                                :name most
                                :kept    (lines (map line-of kept-v))
                                :ejected (lines (map line-of ejected-v)))))
               (rest      (remove-all matched* remaining))   ;; ejected ∉ matched* → returns to pool
               (cluster   (dict :title       (:title synth)
                                :description (:description synth)
                                :name        most
                                :forms       matched*
                                :count       (length matched*))))
          (loop rest (cons cluster clusters) (+ guard 1)))))
  (loop (map (lambda (r) (:description r)) records) '() 0))

(define clusters (consolidate pooled-enriched))

;; ── Stage C: audit (Sonnet, structured, NO recovery) ──────────────────────
(define (cluster->text c)
  (string-append (:title c) " (" (n->s (:count c)) "): " (:description c)
    "\n    forms: " (string-join (:forms c) "; ")))

(define audit
  (run-audit "audit" :meta (dict :model auditor)
    :original (lines pooled-descriptions)
    :clusters (lines (map cluster->text clusters))))

;; ── feature tally (light — no qwen loop, just dedupe + count) ─────────────
(define pooled-features
  (apply append (map (lambda (r) (:features r)) interviews)))

(define (tally items)
  (map (lambda (x) (dict :name x :count (count-if (lambda (y) (equal? y x)) items)))
       (dedupe items)))

;; ── Stage D: assemble + CANARY ────────────────────────────────────────────
;; A non-zero misattribution count flips the canary sentinel — the chart paints
;; this whole record as a yellow warning block + console.warn.
(define mis (:misattributionCount audit))
(define canary-msg
  (string-append (n->s mis)
    " dealbreaker(s) misattributed during consolidation — the clustering is not trustworthy as-is; see audit.mistakes"))

(if (> mis 0)
    (dict "__canary__"          canary-msg
          :personaCount         (length data/personas)
          :dealbreakerClusters  clusters
          :featureTally         (tally pooled-features)
          :audit                audit)
    (dict :personaCount         (length data/personas)
          :dealbreakerClusters  clusters
          :featureTally         (tally pooled-features)
          :audit                audit))
