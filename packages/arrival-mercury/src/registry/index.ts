// registry — the Contract.emit harvest (constitution §4.1/§4.5; registry-emit.md).
// Reads baked declarations from an `EnvCapability[]` tree / assembled ambient without
// arming resources; the emit RULES themselves stay co-located on each symbol's own
// declaration ("one contract, five readers" — the compiler is the fifth).
export { dryActivation } from "./dry-activation.js";
export { assertNarrowsWitnessed, type EmitRegistry, type EmitRegistryRow, emitRegistryOf } from "./harvest.js";
