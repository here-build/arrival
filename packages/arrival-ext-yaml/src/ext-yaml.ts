// yaml — the `.yaml`/`.yml` file-type resolver as an opt-in capability.
//
// The dep-bearing data formats left `@inhuman.tools/arrival/loader`'s builtin table so the
// loader sheds its external deps (per .claude/rules/env-quasi-packages.md — split to
// isolate an external dependency): this capability OWNS the `yaml` parser and registers
// its resolver by name at bootstrap; `require`'s by-name overlay resolves it. The value
// projects through the SAME `normalizeToJson` the builtin data resolvers use (one
// definition, no drift), so `(require "personas.yaml")` yields exactly the same
// data as `.json` would.
import { EnvCapability } from "@inhuman.tools/arrival/capability";
import {
  arrivalLoaderCapability,
  type ContentResolver,
  type ExtensionHandler,
  normalizeToJson,
  type RequireTypeProvider,
  valueToTsType,
} from "@inhuman.tools/arrival/loader";
import { parse as parseYaml } from "yaml";

/** `.yaml`/`.yml` → `{ kind: "value" }` DATA (never a callable — the CALLABLE RULE's
 *  easy half). Bound as a `symbol.native` verb (the raw `{ value }` arm is retired):
 *  `require`'s registered-resolver path dispatches its apply term through `applyCallback`
 *  with `(contents, {path}) → ResolverResult`, args and return raw either way (a native
 *  never marshals). */
const resolveYaml: ContentResolver = (contents) => ({
  kind: "value",
  value: normalizeToJson(parseYaml(String(contents))),
});

/** The editor twin of `resolveYaml` — same parser, same `normalizeToJson` projection,
 *  routed to a TS type STRING instead of a runtime value (one definition per format,
 *  no drift between what the runtime returns and what the lens types). */
const typeYaml: RequireTypeProvider = (source) => {
  try {
    return valueToTsType(normalizeToJson(parseYaml(source)));
  } catch {
    return null; // unparseable mid-edit — no shape, lens falls back to unknown
  }
};

/** Bundles the runtime + editor facets of `.yaml`/`.yml` as ONE definition — the
 *  `Contract.type`-style idiom, at the resolver layer instead of the symbol layer
 *  (a `require`d file's bytes are routed through a resolver before any scheme value
 *  exists, so there is no `Contract` to hang a `type` off directly). Consumed by
 *  arrival-chain's `loaderFromResolver`/`makeFsLoader` to seed `Loader.resolvers` —
 *  the ONLY channel `resolveRequireType` (the editor seam) actually reads; the
 *  `register-extension` prelude below is runtime-only (resolved against a live env,
 *  which the editor never builds) and cannot carry a type provider through itself. */
export const yamlHandler: ExtensionHandler = { resolve: resolveYaml, type: typeYaml };

export const arrivalYamlCapability = EnvCapability.define("yaml", {
  // Loader first in C3: prelude calls require/register-extension (preludeOnly on loader).
  deps: [arrivalLoaderCapability],
  symbols: (symbol, z) => ({
    "yaml/parse": symbol.native`yaml/parse: resolves .yaml/.yml module contents to a ResolverResult (loader registry verb)`(
      { input: [z.schemeValue, z.schemeValue], output: [z.schemeValue] },
      resolveYaml as never,
    ),
  }),
  // Bare symbol — `require/register-extension` is a MACRO so the resolver name is
  // unevaluated (no String(fn) registry poison). Strings still work for compat.
  prelude: `
  (require/register-extension ".yaml" yaml/parse)
  (require/register-extension ".yml" yaml/parse)
`,
});
