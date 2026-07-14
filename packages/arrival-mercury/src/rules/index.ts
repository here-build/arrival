/** Phase-1 symbol rules + the registry overlay (phase1-symbol-rules.md; constitution
 *  §4.3/§7/§2.1/Appendix B). Interim compiler-side placement — see overlay.ts. */
export {
  type OverlayEmitRegistry,
  type OverlayRegistryRow,
  type SymbolRule,
  type SymbolRuleTable,
  withRules,
} from "./overlay.js";
export { inferAsyncSeeds, phase1Rules } from "./phase1.js";
