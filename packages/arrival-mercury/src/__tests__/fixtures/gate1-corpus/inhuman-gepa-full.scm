;; COPY-AS-CHUNK — gate1-corpus manifest entry (verbatim copy for site-density
;; measurement; constitution §9's committed corpus, NOT the compiler's own code —
;; copied here so the corpus is self-contained inside this package, per
;; env-quasi-packages' "never shared imports" spirit applied to fixtures).
;; Source: inhuman/examples/inhuman-gepa-full/gepa.scm (unmodified below the rule).
;;
;; Selection rationale (recorded in the gate1-corpus manifest, gate1/manifest.ts):
;; the full genetic-plus-bandit GEPA variant — by far the densest real program
;; found in the scout (35 car/cdr/cxr+if sites in one file): nested named-let
;; loops over cons cells (find-merge, weighted-index), a two-list `map` zip
;; (pareto-weight), and the classic `(apply map list rows)` transpose idiom
;; (column-maxima).

;; GEPA, full size — reflective prompt evolution WITH the efficiency engine and
;; the genetic half: the parts the sibling `inhuman-gepa` leaves out on purpose.
;;
;;   examples/inhuman-gepa       — the soul: reflect + Pareto frontier (~35 lines).
;;   examples/inhuman-gepa-full  — this: + minibatch gate + rollout budget +
;;                                 Pareto-weighted selection + system-aware merge.
;;
;; The task is a TWO-stage pipeline, so the genetic half has something to
;; recombine:
;;   analyze : message            -> a short rationale     (analyze.prompt)
;;   decide  : rationale, message -> one label             (decide.prompt)
;; A candidate carries an instruction for EACH stage. Mutation reflects on one
;; stage; merge takes the analyze instruction from the candidate that specialised
;; analysis and the decide instruction from the one that specialised the decision.
;;
;; Open in the studio and watch the trace: every (infer …) lights up; the budget
;; drains as candidates are gated on minibatches and promoted on the full set.
;; Re-run replays from cache for $0 — the LCG keeps selection reproducible.

(require "metric.scm")                              ; spills `metric` : (pred expected) -> 0 | 1
(define examples    (require "examples.json"))      ; each: {id, input, expected}
(define run-analyze (require "analyze.prompt"))
(define run-decide  (require "decide.prompt"))
(define run-reflect (require "reflect.prompt"))

;; The evaluation set. A candidate is assessed across it once (`evaluate`), and the
;; Pareto frontier is tracked over those per-example scores. The minibatch gate
;; samples from the parent's OWN stored records (below), so there's no separate
;; trainset to traverse — the gate reads the assessment, it doesn't redo it.
(define paretoset examples)

;; ── the pipeline being optimised ─────────────────────────────────────────────
;; Cache keys are content-derived (the (list …) first arg): two candidates that
;; share an `analyze` instruction reuse its analysis calls — a reason to split
;; the stages rather than fuse them into one prompt.

(define (trace analyze decide ex)
  (let* ((message  (:input ex))
         (analysis (run-analyze (list analyze message)
                                :instruction analyze :message message))
         (label    (run-decide  (list decide message analysis)
                                :instruction decide :message message :analysis analysis)))
    (dict :id (:id ex) :input message :analysis analysis
          :prediction label :expected (:expected ex))))

;; ── one traversal, many consumers ─────────────────────────────────────────────
;; `evaluate` is the SINGLE provenance flow: map the two-stage pipeline across a
;; set, ONCE, into rich per-example records. Everything downstream — scores, the
;; Pareto frontier, the failure set fed to reflection, the minibatch — is a PURE
;; reader of those records, never a second traversal. A record carries everything
;; its readers need (`:id` to re-select it, `:input`/`:expected` so it doubles as
;; an example for re-tracing, `:analysis`/`:prediction` for reflection), so a
;; candidate is assessed by exactly one fan-out and the chart shows that fan-out
;; feeding multiple consumers, not the same calls re-mapped per use.
(define (evaluate analyze decide set)
  (map (cut trace analyze decide <>) set))

(define (rec-score rec) (metric (:prediction rec) (:expected rec)))
(define (scores-of recs) (map rec-score recs))
(define (failures-of recs) (filter (lambda (rec) (zero? (rec-score rec))) recs))

;; ── candidates: an instruction per stage, its evaluation records, and lineage ──
;; `:via` records which stage last changed — "seed" | "analyze" | "decide" | "merge".
;; Merge reads it to recombine complementary specialists. `:recs` is the stored
;; single traversal — scores and failures derive from it, no re-run.

(define (candidate analyze decide via recs)
  (dict :analyze analyze :decide decide :via via :recs recs))

(define (instr-of c stage)
  (if (equal? stage "analyze") (:analyze c) (:decide c)))

(define (assess analyze decide via)                 ; a candidate evaluated on the full set
  (candidate analyze decide via (evaluate analyze decide paretoset)))

(define (scores c) (scores-of (:recs c)))           ; per-example 0/1, read from records
(define (total c) (apply + (scores c)))

;; ── Pareto frontier ───────────────────────────────────────────────────────────
;; a dominates b: at least as good on every example, strictly better on one.

(define (dominates? a b)
  (and (every >= (scores a) (scores b))
       (some  >  (scores a) (scores b))))

(define (frontier pool)
  (filter (lambda (c) (not (some (cut dominates? <> c) pool))) pool))

;; ── reflective mutation (one stage at a time) ─────────────────────────────────
;; Round-robin the stage so both get attention. Returns (analyze decide via) for
;; the proposed child, or #f when this candidate has nothing to fix on the batch.
;; `batch` is a slice of the parent's OWN evaluation records (sampled below), so
;; its failures are read straight off the stored traversal — the reflect call is
;; the only new inference here, fed by records the assess fan-out already produced.

(define (stage-for iter) (if (even? iter) "analyze" "decide"))

(define (propose c batch iter)
  (let* ((stage   (stage-for iter))
         (current (instr-of c stage))
         (fails   (failures-of batch)))
    (if (null? fails)
        #f
        (let ((improved (run-reflect (list stage current fails)
                                     :stage stage :instruction current :failures fails)))
          (if (equal? stage "analyze")
              (list improved (:decide c) "analyze")
              (list (:analyze c) improved "decide"))))))

;; ── system-aware merge (the genetic half) ─────────────────────────────────────
;; Two candidates are complementary when they specialised DIFFERENT stages. The
;; child inherits each stage's instruction from the parent that improved it.

(define (complementary? a b)
  (or (and (equal? (:via a) "analyze") (equal? (:via b) "decide"))
      (and (equal? (:via a) "decide")  (equal? (:via b) "analyze"))))

(define (merge a b)                                 ; assumes (complementary? a b)
  (if (equal? (:via a) "analyze")
      (assess (:analyze a) (:decide b) "merge")
      (assess (:analyze b) (:decide a) "merge")))

;; First complementary pair in the pool, or #f. Nested tail loops.
(define (find-merge pool)
  (let outer ((as pool))
    (if (null? as)
        #f
        (let inner ((bs pool))
          (if (null? bs)
              (outer (cdr as))
              (if (complementary? (car as) (car bs))
                  (list (car as) (car bs))
                  (inner (cdr bs))))))))

;; ── Pareto-weighted (bandit) selection ────────────────────────────────────────
;; Sample the next candidate to mutate, weighted by how many examples it ties the
;; best score on — favouring specialists worth recombining.

(define (column-maxima pool)                        ; best score on each example
  (map (cut apply max <>) (apply map list (map scores pool))))

(define (pareto-weight c maxima)
  (apply + (map (lambda (s m) (if (>= s m) 1 0)) (scores c) maxima)))

;; A reproducible LCG (Park–Miller MINSTD), so a re-run draws the same sequence
;; and every (infer …) replays from cache.
(define (rng-next state) (modulo (* state 16807) 2147483647))
(define (rng-int state n) (modulo state (max n 1)))   ; in [0, n)

;; Walk cumulative weights to turn `target` into an index.
(define (weighted-index weights target)
  (let walk ((ws weights) (i 0) (acc 0))
    (if (or (null? (cdr ws)) (< target (+ acc (car ws))))
        i
        (walk (cdr ws) (+ i 1) (+ acc (car ws))))))

(define (select pool state)                          ; -> (candidate . next-rng)
  (let* ((maxima  (column-maxima pool))
         (weights (map (cut pareto-weight <> maxima) pool))
         (target  (rng-int state (apply + weights))))
    (list (list-ref pool (weighted-index weights target)) (rng-next state))))

;; Sample up to k distinct examples from `set`. -> (batch . next-rng)
(define (picked? ex batch) (some (lambda (p) (equal? (:id p) (:id ex))) batch))

(define (sample-batch set k state)
  (let loop ((picked (list)) (tries (* 3 k)) (s state))
    (if (or (zero? tries) (>= (length picked) k) (>= (length picked) (length set)))
        (list picked s)
        (let ((ex (list-ref set (rng-int s (length set)))))
          (loop (if (picked? ex picked) picked (cons ex picked))
                (- tries 1)
                (rng-next s))))))

;; A PROPOSAL's score over the minibatch — the one genuinely new traversal in a
;; reflective step (new instructions ⇒ a real pipeline run). `batch` is a list of
;; the parent's records, which carry :input/:expected, so they double as examples.
(define (proposal-batch-score analyze decide batch)
  (apply + (scores-of (evaluate analyze decide batch))))

;; The parent's score over the same minibatch is a pure READ — the records were
;; already produced by the parent's assess fan-out, so no second traversal.
(define (parent-batch-score batch)
  (apply + (scores-of batch)))

;; ── the evolution loop ─────────────────────────────────────────────────────────
;; A tail-recursive state machine over (pool, budget, rng, iter). `budget` counts
;; example-evaluations (rollouts): a minibatch to test each mutation, a full set
;; only when it earns promotion. TCO keeps this constant-stack however long it runs.

(define BATCH       4)    ; minibatch size for the cheap gate
(define MERGE-EVERY 3)    ; attempt a merge every Nth iteration

(define (evolve pool budget rng iter)
  (if (<= budget 0)
      pool
      (let ((pair (and (zero? (modulo iter MERGE-EVERY))
                       (find-merge (frontier pool)))))
        (if pair
            ;; genetic step: recombine complementary specialists, re-select frontier
            (evolve (frontier (cons (merge (car pair) (cadr pair)) pool))
                    (- budget (length paretoset))
                    (rng-next rng) (+ iter 1))
            ;; reflective step: select → minibatch → propose → gate → maybe promote.
            ;; The minibatch is sampled from the PARENT's own records, so the parent
            ;; side of the gate and the reflection failures are reads of one stored
            ;; traversal; only the proposal is re-traced.
            (let* ((sel    (select pool rng))
                   (parent (car sel))
                   (rng1   (cadr sel))
                   (smp    (sample-batch (:recs parent) BATCH rng1))
                   (batch  (car smp))
                   (rng2   (cadr smp))
                   (prop   (propose parent batch iter)))
              (if (not prop)
                  (evolve pool (- budget BATCH) rng2 (+ iter 1))
                  ;; Name the proposal's stages and the two sides of the gate, so the
                  ;; trace block reads `prop-score > parent-score` and the minibatch
                  ;; fan-out lands as its own node feeding that comparison.
                  (let* ((p-analyze    (car prop))
                         (p-decide     (cadr prop))
                         (p-via        (caddr prop))
                         (prop-score   (proposal-batch-score p-analyze p-decide batch))
                         (parent-score (parent-batch-score batch)))
                    (if (> prop-score parent-score)
                        ;; gate passed → promote: full evaluation, add to the pool
                        (evolve (frontier (cons (assess p-analyze p-decide p-via) pool))
                                (- budget BATCH (length paretoset))
                                rng2 (+ iter 1))
                        ;; gate failed → discard; only the minibatch was spent
                        (evolve pool (- budget BATCH) rng2 (+ iter 1))))))))))

;; ── run ─────────────────────────────────────────────────────────────────────────
(define BUDGET   100)    ; total rollouts to spend; raise for a longer search
(define SEED-RNG 4)

(define (gepa)
  (let* ((seed  (assess (require "analyze-seed.txt") (require "decide-seed.txt") "seed"))
         (final (evolve (list seed) (- BUDGET (length paretoset)) SEED-RNG 0)))
    (max-by total (frontier final))))

(gepa)
