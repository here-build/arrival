;; Shared config for the whole custdev suite — the UNION of every script's keys.
;; Each script reads only the ones it needs; the rest are inert defines. Demo
;; values are kept small so a run converges fast and stays cheap.

;; ── Product + voice (generate-personas, audience-loop, the reaction prompts) ──
(define config/product-context
  "here.build — a visual builder for React/Next.js web apps with optional Web3. The promise: ship a real, deployable app from a visual editor, with code you own and no lock-in.")
(define config/system-prompt
  "You are simulating one specific early-adopter persona reacting to a developer tool. Stay in their voice — their pains, priors, and dealbreakers. Be blunt; never perform politeness.")

;; ── Reaction fan-out (herebuild-react / herebuild-multi) ──────────────────────
(define config/hero-id   "V1")
(define config/hero-lead "Ship the app, not the boilerplate.")
(define config/replays   3)

;; ── Audience-loop analysis thresholds ─────────────────────────────────────────
(define config/min-replays      3)
(define config/min-for-boundary 3)

;; ── Persona generation (generate-personas) — small for a demo ─────────────────
(define config/total-count 6)
(define config/batch-size  3)

;; ── best-tagline GEPA knobs — small caps so the demo converges quickly ────────
(define config/initial-tagline  "Ship the app, not the boilerplate.")
(define config/max-iter         3)
(define config/plateau-delta    0.02)
(define config/total-iter-cap   8)
(define config/bounce-threshold 0.5)
(define config/pov-count        2)
