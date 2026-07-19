// ext/yaml — the `.yaml`/`.yml` file-type resolver as an opt-in capability.
//
// The dep-bearing data formats left `@inhuman.tools/arrival/loader`'s builtin table so the
// loader sheds its external deps (per .claude/rules/env-quasi-packages.md — split to
// isolate an external dependency): this capability OWNS the `yaml` parser and registers
// its resolver by name at bootstrap; `require`'s by-name overlay resolves it. The value
// projects through the SAME `normalizeToJson` the builtin data resolvers use (one
// definition, no drift), so `(require "personas.yaml")` yields exactly what the same
// data as `.json` would.
//
// NOTE this file was named by `loader.ts`'s migration comment ("each is now its own
// opt-in ext capability (arrival-chain `packs/ext-yaml.ts` / `ext-toml.ts`)") but got
// LOST IN TRANSLATION during the env-loader extraction — the registration never landed,
// so every `.yaml` require died with "no resolver" (audience-loop / herebuild-* /
// best-tagline / enrich-distant pinned exactly that). Same recovery class as the
// `.prompt`/`.hbs` capabilities.
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
 *  easy half). Bound as `{ value }` so `require` gets the raw fn back (no rosetta
 *  marshalling) and calls it `(contents, {path}) → ResolverResult`. */
const resolveYaml: ContentResolver = (contents) => ({
  kind: "value",
  value: normalizeToJson(parseYaml(String(contents))),
});

/** The editor twin of `resolveYaml` — same parser, same `normalizeToJson` projection,
 *  routed to a TS type STRING instead of a runtime value (one definition per format,
 *  no drift between what the runtime returns and what the lens types). Lost when this
 *  capability was recovered post-extraction (see the file header); restored here. */
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

export const arrivalYamlCapability = new EnvCapability("ext/yaml", {
  // Loader first in C3: prelude calls require/register-extension (preludeOnly on loader).
  deps: [arrivalLoaderCapability],
  symbols: { "ext/yaml/resolve": { value: resolveYaml } },
  // Bare symbol — `require/register-extension` is a MACRO so the resolver name is
  // unevaluated (no String(fn) registry poison). Strings still work for compat.
  prelude: `
  (require/register-extension ".yaml" ext/yaml/resolve)
  (require/register-extension ".yml" ext/yaml/resolve)
`,
});
