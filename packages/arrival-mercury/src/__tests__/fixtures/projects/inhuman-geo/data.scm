;; ════════════════════════════════════════════════════════════════════════
;; data.scm — hand-authored ground truth for the GEO loop
;; ════════════════════════════════════════════════════════════════════════
;;
;; This is the ONLY hand-authored file. It carries four things the loop cannot
;; invent for itself:
;;   geo/target       — the page we optimize. Its `realCapabilities` are GROUND
;;                      TRUTH: the second (honesty) judge gates every mutation
;;                      against these so the optimizer cannot win by lying.
;;   geo/competitors  — the rival SERP entries the target is ranked among. Fixed,
;;                      so rank-delta measures OUR metadata change, nothing else.
;;   geo/queries      — the agentic-search queries we optimize for.
;;   geo/searchers    — a small panel of grounded searcher individuals. Rank is a
;;                      DISTRIBUTION across this panel (entropy is the deliverable),
;;                      never a single number.
;;
;; INTERNAL TOOL — for ourselves, not a public product. We optimize OUR OWN
;; metadata against a judge that is a faithful sibling of the production agentic
;; ranker. That collapses the public-product cost (no dark-vs-clean attestation,
;; no ToS exposure) the assessment priced — we audit our own honesty directly.

;; ── the page under optimization ───────────────────────────────────────────
(define geo/target
  (dict
    :name "here.build"
    :url  "https://here.build"
    ;; GROUND TRUTH — what the page can HONESTLY claim. The honesty judge rejects
    ;; any mutated metadata that asserts a capability not entailed by this list.
    :realCapabilities (list
      "visual web application builder that emits React / Next.js code"
      "optional Web3 / wallet integration (RainbowKit, viem, wagmi)"
      "AI-agent-editable via MCP (agents author the app, not just chat about it)"
      "real-time collaborative editing"
      "exports real, ownable source code (no platform lock-in)"
      "constraint-based design system that prevents broken visual states")
    ;; SEED metadata — the starting point the loop mutates.
    :ogTitle       "here.build — visual app builder"
    :ogDescription "Build web apps visually. Export React code."))

;; ── the competitive SERP (fixed rivals, authored once) ────────────────────
;; The target is injected among these at geo/inject-rank; the judge re-ranks all
;; of them by relevance to each query. Only the target's metadata changes round
;; to round, so any rank movement is attributable to our mutation alone.
(define geo/competitors
  (list
    (dict :name "Webflow"
          :ogTitle "Webflow: Build with the power of code — without writing any"
          :ogDescription "Create custom, responsive websites with a visual canvas. CMS, hosting, and interactions built in.")
    (dict :name "Framer"
          :ogTitle "Framer — The website builder loved by designers"
          :ogDescription "Design and publish stunning sites. AI, CMS, animations, and instant publishing.")
    (dict :name "Bubble"
          :ogTitle "Bubble: The full-stack no-code app builder"
          :ogDescription "Build production-grade web apps without code. Workflows, database, and plugins.")
    (dict :name "Plasmic"
          :ogTitle "Plasmic — Visual builder for your codebase"
          :ogDescription "Design and ship UI fast. Integrates with React, Next.js, and your existing components.")
    (dict :name "Lovable"
          :ogTitle "Lovable — Build software products with AI"
          :ogDescription "Describe your idea in chat and get a working full-stack app. Edit, deploy, ship.")
    (dict :name "Vercel v0"
          :ogTitle "v0 by Vercel — Generate UI with AI"
          :ogDescription "Generate React + Tailwind UI from a prompt. Copy the code into your project.")
    (dict :name "Builder.io"
          :ogTitle "Builder.io — Visual headless CMS"
          :ogDescription "Drag-and-drop visual editing on your live site, powered by your code components.")
    (dict :name "Retool"
          :ogTitle "Retool — Build internal tools remarkably fast"
          :ogDescription "Assemble apps from pre-built components wired to your data. For internal teams.")
    (dict :name "WordPress"
          :ogTitle "WordPress.com — Website builder & hosting"
          :ogDescription "Create any kind of website. Blogs, stores, portfolios — with themes and plugins.")))

;; ── the agentic-search queries we optimize for ────────────────────────────
(define geo/queries
  (list
    "I want to build a web app visually but keep ownership of the React source code"
    "best tool for an AI agent to build and edit a real web application"
    "visual builder that can add crypto wallet login to my site"))

;; ── the searcher panel — grounded individuals, rank is a distribution ──────
;; Each is one idiosyncratic person (the personas-cohort fidelity lever), not a
;; demographic sketch. The agent embodies one of these when ranking the SERP.
(define geo/searchers
  (list
    "Devon, a freelance React developer who has been burned by no-code lock-in before and reflexively checks whether he can eject to real source. Skeptical of marketing superlatives; trusts concrete technical nouns."
    "Priya, a solo founder shipping a web3 ticketing MVP this month. She does not write much code and is delegating the build to an AI agent. She cares whether the agent can actually DO the work, not just suggest it."
    "Marcus, a design-systems lead evaluating tools for a small team. He distrusts anything that sounds like it produces messy output, and weights 'clean code' and 'no broken states' heavily."))

;; ── loop knobs ────────────────────────────────────────────────────────────
(define geo/inject-rank   10)   ;; the target starts at position #10 (V's "place it at #10")
(define geo/max-iterations 6)   ;; bounded convergence (the loop's hard backstop)
(define geo/transfer-gap   2.0) ;; mean-rank disagreement (sandbox vs auditor) that flips the canary
