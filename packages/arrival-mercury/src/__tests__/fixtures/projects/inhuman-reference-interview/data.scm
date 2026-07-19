;; ════════════════════════════════════════════════════════════════════════
;; data.scm — HAND-AUTHORED INPUT (the real-grounded seed + the feature space)
;; ════════════════════════════════════════════════════════════════════════
;;
;; This file is the ONE place authored by a human (V/Claude), not by inference.
;; `(require "data.scm")` SPILLS these three defines into the run env (load
;; semantics, like config.scm) — personas.scm reads them, interview.scm reads
;; them transitively.
;;
;; WHY a hand-authored seed instead of a model-generated one (cohort finding,
;; project_synthetic_personas): the strongest measured fidelity lever is
;; GROUNDING IN IDIOSYNCRATIC REAL-INDIVIDUAL DETAIL — it stops the model
;; falling back on demographic/stereotype priors and measurably reduces subgroup
;; bias. So `data/seed` is one SPECIFIC person with specific quirks, not a
;; demographic sketch ("a 30-something developer"). The divergence loop then
;; pushes MAXIMALLY FAR from this anchor — a grounded anchor makes "far" mean
;; something. The naming `data/seed` / `data/personas` mirrors V's `(declare
;; data/…)` intent; arrival-chain has no `declare` form, so it is a `define`
;; that the next file spill-imports.

;; ── the grounded seed core ───────────────────────────────────────────────
;; One real, specific individual from the CORE audience. Texture is deliberate:
;; the stationery drawer, the Porto co-working desk, the abandoned Gatsby blog —
;; these are the "opaque connection" hooks the persona can later mine when asked
;; an oblique question, not decoration.
(define data/seed
  (string-append
    "I'm Mira Calder, 34, and I build small web things for money out of a "
    "co-working desk in Porto — two days a week it's a client's booking site, "
    "the other three it's whatever side project hasn't bored me yet. I can code; "
    "I just resent writing the same auth-and-form boilerplate for the 200th time. "
    "I came up through WordPress and then a long Gatsby phase I'm embarrassed about "
    "(I have a graveyard of half-migrated blogs). I keep a drawer of fountain pens "
    "and I'm weirdly opinionated about the weight of paper, which is to say I notice "
    "when a tool's defaults are tasteful versus when someone just shipped Bootstrap. "
    "My clients are physiotherapists and a vinyl shop and one very demanding pilates "
    "studio — none of them care about React, they care that the thing loads on a cheap "
    "Android and that I can change the opening hours myself without emailing me. "
    "I bill by the project, so anything that turns three days of plumbing into an "
    "afternoon is literally money. I'm allergic to lock-in: I got burned when a "
    "no-code platform held a client's site hostage behind a price hike, so now I "
    "want to own the code and host it wherever I want."))

;; ── the audience one-liner (the CORE, not the general market) ─────────────
(define data/audience
  (string-append
    "Indie developers and tiny agencies who can code but want to ship client and "
    "side-project web apps fast without hand-writing boilerplate — and who care, "
    "sometimes burned-once care, about OWNING the output and avoiding lock-in."))

;; ── the feature space (deliberately HUGE and over-inclusive) ──────────────
;; The point is breadth: a long, varied surface so the interview can surface
;; which features personas reach for and which absences are dealbreakers. Not a
;; roadmap — a stimulus set. Mixes table-stakes, differentiators, and edges.
(define data/features
  (list
    "Visual drag-and-drop builder that emits real React / Next.js code"
    "You own 100% of the generated code — export anytime, no lock-in"
    "One-click deploy to your own hosting (Vercel, Cloudflare, a VPS)"
    "Self-host the editor itself if you want to"
    "Component library with variants and props, like real components"
    "Design tokens / theme system shared across a whole project"
    "Responsive layout with real breakpoints, not magic pixel-pushing"
    "Dark mode and light mode handled as a first-class mode axis"
    "Reusable layouts (header / footer / shell) applied across pages"
    "CMS-style editable content so clients can change copy themselves"
    "A client-editor mode: hand a limited, safe editing view to a non-dev"
    "Forms with validation, spam protection, and email delivery built in"
    "Auth: email, magic-link, OAuth, without wiring it yourself"
    "Database-backed dynamic pages (list + detail) from your own data"
    "Connect an existing API or database as a data source"
    "Built-in image optimization and responsive images"
    "SEO controls: meta, Open Graph, sitemap, structured data"
    "Accessibility checks and sane a11y defaults"
    "Optional Web3: wallet connect (RainbowKit), on-chain reads/writes"
    "Multi-chain config for the Web3 features"
    "Smart-contract ABI import and typed contract calls"
    "Stripe / payments integration for selling something"
    "Internationalization / multiple languages per page"
    "Real-time collaboration — multiple people editing at once"
    "Version history and the ability to roll a page back"
    "Branching / staging so you can preview before publishing"
    "An AI assistant that can build or edit the app from a prompt"
    "An MCP / API surface so an agent can drive the builder"
    "Animations and transitions authored visually, emitted as CSS"
    "Custom CSS / className escape hatch when you need it"
    "Code components: drop in your own React component and use it visually"
    "Per-page custom <head>, scripts, and analytics snippets"
    "Static export (SSG) for cheap, fast, crawlable pages"
    "Server-side rendering for dynamic, authed pages"
    "A component marketplace / templates to start from"
    "Git integration — the project lives in a repo you control"
    "Environment variables and secrets management per environment"
    "Role-based permissions for a team working on one project"
    "Audit log of who changed what"
    "Performance budget warnings (bundle size, Lighthouse)"
    "White-label so an agency can ship it under its own brand"
    "Offline-first / PWA output for installable apps"
    "Email template authoring alongside the site"
    "A/B testing and feature flags"
    "Webhooks and automation triggers"))
