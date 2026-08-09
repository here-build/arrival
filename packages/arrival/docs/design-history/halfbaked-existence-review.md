# AHalfBaked — rejected alternative

`AHalfBaked` was a runtime value carrier for speculative evaluation: `filter`/`map`
over a promise-bearing fan could emit a lazy carrier whose per-slot cardinality formed
a narrowing interval, and numeric comparisons could decide a branch as soon as the
interval became decisive, with slots still pending. The intent was to let code like
`(if (>= (length (filter pred items)) 2) …)` take its branch before the filtered list
finished settling.

The carrier does not survive contact with synchronous egress. Container egress crosses
the boundary through lazy proxies whose `get` traps are synchronous; a live,
still-resolving carrier reaching that boundary would need an asynchronous trap, which
does not exist. The only ways to close that gap both defeat the carrier: await full
settlement before returning (erasing the optimization at the one boundary anyone
observes), or let a pending value sit inside an otherwise-plain result (breaking the
plain-JS-observable guarantee egressed values are expected to hold).

Everywhere a carrier could appear also had to defend against one arriving live —
membrane, egress, and environment code all paid a permanent tax to stay carrier-aware
for a value that, in practice, no caller ever produced outside the feature's own tests.

`AHalfBaked` is gone: the carrier, its producer wiring, and its dedicated tests no
longer exist. The capability it was chasing — deciding a monotone control-flow branch
before a fan fully settles — is real, and moves forward as an acceptance criterion for
struct-fact wires (the static generalization of the same cardinality interval) in
[`execution-plan-wireframe.md`](execution-plan-wireframe.md), "Cardinality facts without a
runtime carrier".
