/**
 * `arrival/handlebars` — opt-in EnvCapability that OWNS the handlebars dep
 * (env-quasi-packages: split to isolate an external dependency).
 *
 * Import faces:
 *   • `.hbs` require → pretreat to scheme (import executable), not a dict
 *   • verbs: template/handlebars, handlebars/parse, handlebars/run
 *
 * Compiler: Contract.emit → RuntimeRef; RUNTIME_MANIFEST maps those symbols to
 * this package's `/runtime` subpath (the mercury reference example).
 */
import { EnvCapability, jsToScheme, parse, schemeToJsUntyped } from "@inhuman.tools/arrival";
import { Call, type EmitRule, type R } from "@inhuman.tools/arrival/emit";
import { arrivalLoaderCapability } from "@inhuman.tools/arrival/capabilities/loader";

import { asCompiledTemplate, compileTemplate, renderTemplateCall, runCompiledTemplate } from "./compile.js";
import { hbsContentsToSchemeSource } from "./scheme.js";

/** Emit as RuntimeRef(shim) — mercury materializes via RUNTIME_MANIFEST pkg rows. */
const runtimeEmit = (verb: string): EmitRule<R> => ({
  call: (args, ctx) => Call(ctx.runtime(verb), args),
});

export const arrivalHandlebarsCapability = EnvCapability.define("arrival/handlebars", {
  // Loader first in C3: prelude calls require/register-extension (preludeOnly on loader).
  deps: [arrivalLoaderCapability],
  symbols: (symbol, z) => ({
    "template/handlebars":
      symbol.rosetta`template/handlebars: renders a handlebars template source string against the given args`(
        {
          // `args` is genuinely runtime-shaped (any dict/array a caller hands the template) —
          // the rosetta escape hatch, not a real codec.
          input: [z.string, z.dynamic],
          type: "(source: string, args: unknown): string",
          output: [z.string],
          provenance: "pipe",
          emit: runtimeEmit("template/handlebars"),
        },
        (source, args) => {
          const a = schemeToJsUntyped(args, {});
          return renderTemplateCall(source, Array.isArray(a) ? a : [a]);
        },
      ),
    // The loader-registry resolver as an ordinary native verb (the raw `{ value }` arm is
    // retired): `require` dispatches its apply term with `(contents, {path}) → ResolverResult`,
    // raw either way (a native never marshals).
    "ext/handlebars/resolve": symbol.native`ext/handlebars/resolve: resolves .hbs module contents to a ResolverResult (loader registry verb)`(
      { input: [z.schemeValue, z.schemeValue], output: [z.schemeValue] },
      (async (contents: unknown) => ({
        kind: "eval" as const,
        forms: await parse(hbsContentsToSchemeSource(String(contents))),
      })) as never,
    ),
    "handlebars/parse": symbol.rosetta`handlebars/parse: compiles a handlebars template source once (cached by source)`(
      {
        input: [z.string],
        // TODO(@arrival.private): `CompiledTemplate` is a plain interface (render fn + info),
        // not yet a branded class — once it is, this becomes `instance(CompiledTemplateClass)`
        // (a real codec, the whiteroom opaque-crossing contract). Until then z.dynamic is the
        // honest escape hatch: the raw box crosses untouched (jsToScheme/schemeToJsUntyped).
        output: [z.dynamic],
        provenance: "pipe",
        type: "(source: string): CompiledTemplate",
        emit: runtimeEmit("handlebars/parse"),
      },
      function (source) {
        return jsToScheme(this.runCtx, compileTemplate(source));
      },
    ),
    "handlebars/run": symbol.rosetta`handlebars/run: renders a previously compiled handlebars template with args`(
      {
        // TODO(@arrival.private): `compiled` is the same not-yet-branded CompiledTemplate handle
        // as handlebars/parse's output (see that comment); `args` is genuinely runtime-shaped.
        // Both z.dynamic — the rosetta escape hatch, not real codecs.
        input: [z.dynamic, z.dynamic],
        output: [z.string],
        provenance: "pipe",
        type: "(compiled: CompiledTemplate, args: unknown): string",
        emit: runtimeEmit("handlebars/run"),
      },
      (compiledRaw, argsRaw) => {
        const a = schemeToJsUntyped(argsRaw, {});
        return runCompiledTemplate(asCompiledTemplate(schemeToJsUntyped(compiledRaw, {})), Array.isArray(a) ? a : [a]);
      },
    ),
  }),
  // Bare symbol — require/register-extension is a MACRO (unevaluated name).
  prelude: `(require/register-extension ".hbs" ext/handlebars/resolve)`,
});
