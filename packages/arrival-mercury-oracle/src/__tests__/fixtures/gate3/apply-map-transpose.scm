; Gate 3 — apply patterns, half 2: `(apply map list rows)`, the classic
; transpose idiom (constitution §6; found independently occurring in the
; gate1-corpus's `inhuman-gepa-full.scm` `column-maxima`). Three arguments to
; `apply` (not two), so `applyRule`'s `FOLD_OPS` shortcut does NOT fire —
; this falls to the generic `Call(f, [...fixed, Spread(last)])` shape, and
; `map` in value position resolves through the stage-0 shim's n-ary zip
; (`src/runtime/stage0.ts`'s `map`, "call position never reaches here").
;
; goldenEpoch: 3 — see ../gate3/REBASE_LOG.md before touching `golden` below.

(apply map list (list (list 1 2) (list 3 4)))
