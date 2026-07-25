// ─────────────────────────────────────────────────────────────────────────────
// `list` — variadic list constructor.
//
// Scheme semantics: (list x₀ x₁ … xₙ) → a proper list of the arguments.
// // ─────────────────────────────────────────────────────────────────────────────

declare function list<T>(...xs: T[]): List<T>;
