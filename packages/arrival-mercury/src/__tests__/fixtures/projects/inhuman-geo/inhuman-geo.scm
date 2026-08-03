;; COPY-AS-CHUNK — gate1-corpus manifest entry (verbatim copy for site-density
;; measurement; constitution §9's committed corpus, NOT the compiler's own code —
;; copied here so the corpus is self-contained inside this package, per
;; env-quasi-packages' "never shared imports" spirit applied to fixtures).
;; Source: inhuman/examples/inhuman-geo/geo.scm (unmodified below the rule).
;;
;; Selection rationale (R5a manifest widening): a bounded-recursion convergence
;; loop over metadata with a second constraining (honesty) judge and a tiered
;; audit — 12 car/if sites (5 car, 7 if), ALL clean under today's rules; measured
;; via gate1/measure.ts's own `measureProgram`, not eyeballed. Chosen alongside
;; inhuman-custdev-best-tagline.scm and inhuman-reference-interview.scm to dilute
;; the original manifest's 92%-in-one-file concentration with real, differently-
;; shaped programs rather than synthetic filler.
;;
;; ════════════════════════════════════════════════════════════════════════
;; geo.scm — the GEO / LLEO convergence loop (internal tool)
;; ════════════════════════════════════════════════════════════════════════
;;
;; The first member of the "optimization against a runnable LLM judge" family
;; built for ourselves. In production the agentic-search ranker IS an LLM, so the
;; sandbox judge here is a faithful SIBLING of the real decision function — which
;; is exactly why dropping the marginal experiment to ~$0 makes the estimate
;; TRUER, not just cheaper (the validity-gap INVERSION). See
;; docs/working-proposals/research/runnable-judge-roi-assessment-2026-06-07.md.
;;
;; SHAPE (the reference-pipeline idioms, reused):
;;   - convergence loop (bounded recursion, data-dependent depth) over metadata
;;   - a SECOND constraining judge (honesty) gating every mutation — the Goodhart
;;     guard the assessment named as universal across the whole task family
;;   - a tiered audit: the converged finalist is re-judged by the :auditor tier
;;     (production-faithful / swappable for a REAL search endpoint via :meta)
;;   - a CANARY on the sibling-vs-production transfer gap (the category-defining
;;     false-credibility risk) — render-recognized value shape, no runtime change
;;
;; Rank is measured as a DISTRIBUTION across (queries × searcher panel) and
;; reduced to a mean — entropy embraced, never a single point estimate.

(require "data.scm")   ;; geo/target, geo/competitors, geo/queries, geo/searchers, knobs

;; ── prelude (same helpers the reference pipeline spills) ──────────────────
(define n->s number->string)
(define (lines xs) (string-join xs "\n"))
(define (mean xs) (/ (apply + xs) (length xs)))

;; ── model environment (materialization — swap envs by editing only this) ──
;; :judge is the sandbox sibling; :auditor is the production-faithful tier. To run
;; against a REAL agentic-search API, point :auditor's NAME at it in
;; inhuman.config.json — the pipeline does not change (intent over materialization).
(define geo/models
  (dict
    :judge      "openrouter/owl-alpha"     ;; the sandbox sibling ranker (cheap, runs every round)
    :mutator    "claude-sonnet-4-6"        ;; proposes metadata
    :structurer "qwen/qwen3.6-35b-a3b"     ;; extracts rank integers (local, ~free)
    :honesty    "claude-sonnet-4-6"        ;; the Goodhart guard — stronger than the mutator
    :auditor    "claude-opus-4-8"))        ;; production-faithful audit tier (swap for a real search endpoint)

;; ── inference units ───────────────────────────────────────────────────────
(define run-search  (require "persona-search.prompt"))
(define run-rank    (require "extract-rank.prompt"))
(define run-mutate  (require "mutate-meta.prompt"))
(define run-honesty (require "honesty-judge.prompt"))
(define run-audit   (require "audit.prompt"))

(define judge      (:judge geo/models))
(define mutator    (:mutator geo/models))
(define structurer (:structurer geo/models))
(define honesty    (:honesty geo/models))
(define auditor    (:auditor geo/models))

;; ── list helpers (keep geo.scm standalone; avoid non-portable list-head/tail) ─
(define (index-map* f xs)
  (define (loop i xs acc)
    (if (null? xs) (reverse acc)
        (loop (+ i 1) (cdr xs) (cons (f i (car xs)) acc))))
  (loop 0 xs '()))

(define (take* xs n)
  (if (or (<= n 0) (null? xs)) '()
      (cons (car xs) (take* (cdr xs) (- n 1)))))

(define (drop* xs n)
  (if (or (<= n 0) (null? xs)) xs
      (drop* (cdr xs) (- n 1))))

;; ── SERP synthesis (pure scheme — no inference) ───────────────────────────
;; Format one result block. The target carries the CANDIDATE metadata under test.
(define (result->block name title desc)
  (string-append name "\n  title: " title "\n  description: " desc))

;; Build the SERP for a candidate metadata, injecting the target at geo/inject-rank
;; among the fixed competitors. Only the target block changes round to round.
(define (synth-serp title desc)
  (define comp-blocks
    (map (lambda (c) (result->block (:name c) (:ogTitle c) (:ogDescription c)))
         geo/competitors))
  (define target-block
    (result->block (:name geo/target) title desc))
  ;; splice the target in at 1-based geo/inject-rank (clamped to the list length)
  (define pos (min (- geo/inject-rank 1) (length comp-blocks)))
  (define spliced
    (append (take* comp-blocks pos)
            (list target-block)
            (drop* comp-blocks pos)))
  ;; number them as a presented SERP
  (lines (index-map* (lambda (i b) (string-append (n->s (+ i 1)) ". " b)) spliced)))

;; ── measurement: mean rank of a candidate across the panel ────────────────
;; Returns (dict :mean <number> :feedback <prose across the panel>). Uses the
;; tier passed in (sandbox :judge each round; :auditor for the finalist audit),
;; so the SAME measurement code runs the sibling and the production-faithful tier
;; — that is what makes the transfer gap a clean apples-to-apples comparison.
(define (measure-rank title desc ranker tag run-prompt)
  (define serp (synth-serp title desc))
  ;; one judge call per (query × searcher) — rank is a distribution
  (define trials
    (apply append
      (index-map*
        (lambda (qi q)
          (index-map*
            (lambda (si persona)
              (let* ((key  (string-append tag "/" (n->s qi) "-" (n->s si)))
                     (rank-prose (run-prompt key :meta (dict :model ranker)
                                   :persona persona :query q :serp serp))
                     (r (:rank (run-rank (string-append key "-x")
                                 :meta (dict :model structurer)
                                 :target (:name geo/target) :ranking rank-prose))))
                (dict :rank r :reasoning rank-prose)))
            geo/searchers))
        geo/queries)))
  (dict :mean     (mean (map (lambda (t) (:rank t)) trials))
        :feedback (lines (map (lambda (t) (:reasoning t)) trials))))

;; the auditor prompt has no :persona slot — wrap it to the same arity
(define (audit-rank title desc tag)
  (define serp (synth-serp title desc))
  (define trials
    (index-map*
      (lambda (qi q)
        (:rank (run-rank (string-append tag "/" (n->s qi) "-x")
                 :meta (dict :model structurer)
                 :target (:name geo/target)
                 :ranking (run-audit (string-append tag "/" (n->s qi))
                            :meta (dict :model auditor) :query q :serp serp))))
      geo/queries))
  (mean trials))

;; ── the convergence loop ──────────────────────────────────────────────────
;;
;; Bounded recursion. Each round: measure the current metadata's mean rank, ask
;; the mutator for a sharper variant, GATE it through the honesty judge, and keep
;; it only if it is honest AND ranks better. Terminate on rank #1, on N rounds,
;; or when no honest improvement is found (the progress is monotone in best-rank,
;; so the loop cannot spin). `history` records every round for legibility.
(define (optimize)
  (define caps (lines (:realCapabilities geo/target)))
  (define qstr (lines geo/queries))
  (define (loop i title desc best-mean dishonest history)
    (if (or (>= i geo/max-iterations) (<= best-mean 1))
        (dict :title title :desc desc :mean best-mean
              :dishonestRejections dishonest :history (reverse history))
        (let* ((m       (measure-rank title desc judge (string-append "round/" (n->s i)) run-search))
               (cur     (:mean m))
               ;; propose a sharper variant from the panel's reasoning
               (prop    (run-mutate (string-append "mutate/" (n->s i))
                          :meta (dict :model mutator)
                          :capabilities caps :queries qstr
                          :title title :description desc :feedback (:feedback m)))
               (ntitle  (:ogTitle prop))
               (ndesc   (:ogDescription prop))
               ;; GOODHART GUARD — honesty gate, stronger model
               (h       (run-honesty (string-append "honesty/" (n->s i))
                          :meta (dict :model honesty)
                          :capabilities caps :title ntitle :description ndesc))
               (ok      (:honest h))
               (rec     (dict :round i :title title :mean cur
                              :proposedTitle ntitle :honest ok :honestReason (:reason h))))
          (if (not ok)
              ;; rejected dishonest mutation — keep current, count it, continue
              (loop (+ i 1) title desc (min best-mean cur) (+ dishonest 1) (cons rec history))
              ;; honest: measure the variant; keep whichever ranks better (lower)
              (let* ((m2  (measure-rank ntitle ndesc judge (string-append "round/" (n->s i) "-v") run-search))
                     (nm  (:mean m2)))
                (if (< nm (min best-mean cur))
                    (loop (+ i 1) ntitle ndesc nm dishonest (cons rec history))
                    (loop (+ i 1) title desc (min best-mean cur) dishonest (cons rec history))))))))
  (loop 0 (:ogTitle geo/target) (:ogDescription geo/target) 99 0 '()))

(define result (optimize))

;; ── tiered audit + transfer canary ────────────────────────────────────────
;; Re-judge the converged finalist on the production-faithful :auditor tier. The
;; gap between the sandbox mean and the auditor mean is the sibling-vs-production
;; transfer gap the assessment named as the category-defining risk. A large gap
;; (or any dishonest rejections having been needed) flips the canary so a clean,
;; confident number can never be laundered into a deck as "we rank you higher."
(define sandbox-mean (:mean result))
(define audit-mean   (audit-rank (:title result) (:desc result) "audit"))
(define gap          (abs (- audit-mean sandbox-mean)))

(define canary-msg
  (string-append
    "transfer gap " (n->s gap) ": sandbox sibling ranked the finalist at mean "
    (n->s sandbox-mean) " but the production-faithful auditor put it at " (n->s audit-mean)
    ". Trust DIRECTION (the metadata the agent prefers), never the magnitude — re-validate against a real search endpoint before claiming a rank."))

(define payload
  (dict :finalTitle        (:title result)
        :finalDescription  (:desc result)
        :sandboxMeanRank    sandbox-mean
        :auditorMeanRank    audit-mean
        :transferGap        gap
        :dishonestRejections (:dishonestRejections result)
        :history            (:history result)))

;; canary if the sibling disagrees materially with the auditor, OR if the loop
;; had to reject dishonest mutations (a sign the objective was pulling toward Goodhart)
(if (or (> gap geo/transfer-gap) (> (:dishonestRejections result) 0))
    (dict "__canary__" canary-msg
          :finalTitle (:finalTitle payload) :finalDescription (:finalDescription payload)
          :sandboxMeanRank sandbox-mean :auditorMeanRank audit-mean :transferGap gap
          :dishonestRejections (:dishonestRejections result) :history (:history payload))
    payload)
