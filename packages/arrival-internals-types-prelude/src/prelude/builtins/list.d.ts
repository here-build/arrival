// ─────────────────────────────────────────────────────────────────────────────
// `list` — variadic list constructor.
//
// Scheme semantics: (list x₀ x₁ … xₙ) → a proper list of the arguments.
// merge contract: ../types.d.ts THE LEAF MERGE CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  list<T>(...xs: T[]): List<T>;
}
