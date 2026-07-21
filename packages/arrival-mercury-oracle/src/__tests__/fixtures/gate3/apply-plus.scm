; Gate 3 — apply patterns, half 1: `(apply + xs)` → a `reduce` with the correct
; additive identity (constitution §6's preserved-knowledge row; `applyRule`'s
; `FOLD_OPS` table). Structural recognition over the ALREADY-LOWERED operand —
; `+` in value position is `RuntimeRef("+")` before this rule ever runs (Law A:
; the rule reads the lowered value in hand, never the source syntax).
;
; The accumulator now reads `total` (naming lane item 4 — the fold-role gate,
; `naming/census.ts`'s `foldRoleNames`, keyed off the `+` operator this
; SAME already-lowered `Bin` shape carries): no coupling to `applyRule`
; itself, a pure structural read of the residual it already produces. `xs`'s
; literal-array receiver (`[1, 2, 3]`) has no derivable collection name, so
; the item stays the honest generic `__item` — the same "no proof ⇒ no
; guess" discipline `car`'s own `.ref` eta-expansion follows.
;
; goldenEpoch: 6 — see ../gate3/REBASE_LOG.md before touching `golden` below.

(apply + (list 1 2 3))
