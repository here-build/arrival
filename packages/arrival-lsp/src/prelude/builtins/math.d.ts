// ─────────────────────────────────────────────────────────────────────────────
// `abs` `sqrt` `floor` `round` `min` `max` — numeric math cluster.
//
// Scheme semantics:
//   (abs x)          → |x|, same type (number → number)
//   (sqrt x)         → square root
//   (floor x)        → largest integer ≤ x
//   (round x)        → nearest integer (banker's rounding per R7RS)
//   (min x ...)      → smallest of one or more numbers
//   (max x ...)      → largest of one or more numbers
//
// merge contract: ../types.d.ts THE LEAF MERGE CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  abs(x: number): number;
  sqrt(x: number): number;
  floor(x: number): number;
  round(x: number): number;
  min(...n: number[]): number;
  max(...n: number[]): number;
}
