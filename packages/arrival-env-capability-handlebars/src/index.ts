// @inhuman.tools/arrival-env-capability-handlebars
//
// Reference opt-in EnvCapability: owns the handlebars dep, teaches `.hbs` require
// (import-executable pretreat → scheme lambda), and exposes pure convert + /runtime
// for mercury. See package README.

export { arrivalHandlebarsCapability } from "./capability.js";
export {
  asCompiledTemplate,
  compileTemplate,
  type CompiledTemplate,
  renderTemplateCall,
  resolveTemplateInput,
  runCompiledTemplate,
} from "./compile.js";
export { hbsContentsToSchemeSource } from "./scheme.js";
export {
  analyzeTemplate,
  coerceShape,
  type Shape,
  type TemplateInfo,
  validateShape,
} from "./template-analyze.js";
