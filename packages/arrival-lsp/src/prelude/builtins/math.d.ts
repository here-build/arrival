// ─────────────────────────────────────────────────────────────────────────────
// L<math> — `abs` `sqrt` `floor` `round` `min` `max` — numeric math cluster.
//
// Scheme semantics:
//   (abs x)          → |x|, same type (number → number)
//   (sqrt x)         → square root
//   (floor x)        → largest integer ≤ x
//   (round x)        → nearest integer (banker's rounding per R7RS)
//   (min x ...)      → smallest of one or more numbers
//   (max x ...)      → largest of one or more numbers
//
// Runtime truth (the `any` impl this SHARPENS — do NOT import it):
//   bridge.ts:571 (abs)  bridge.ts:605 (floor)  bridge.ts:608 (round)
//   bridge.ts:609 (sqrt) bridge.ts:598 (max)     bridge.ts:599 (min)
//   inference-env.ts:326 (max)  inference-env.ts:327 (min)
//
// Pattern: re-declare `interface ArrShape` with these cohesive members, written
// purely in terms of PRE's base types (`SNum`). TS merges this into the shared
// `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  abs(x: SNum): SNum;
  sqrt(x: SNum): SNum;
  floor(x: SNum): SNum;
  round(x: SNum): SNum;
  min(...n: SNum[]): SNum;
  max(...n: SNum[]): SNum;
}
