// ext/toml — the `.toml` file-type resolver as an opt-in capability.
//
// The twin of `ext-yaml.ts` (see its header for the whole story — the dep-isolation
// split AND the lost-in-translation recovery): this capability OWNS the `smol-toml`
// parser, registers `.toml` by name at bootstrap, and projects the parsed value through
// the shared `normalizeToJson` so a `.toml` require yields JSON-shaped data identical
// to its `.json` twin (smol-toml's Dates → ISO strings, etc.).
import { EnvCapability } from "@inhuman.tools/arrival/capability";
import { parse as parseToml } from "smol-toml";

import {
  arrivalLoaderCapability,
  normalizeToJson,
  valueToTsType,
  type ContentResolver,
  type ExtensionHandler,
  type RequireTypeProvider,
} from "@inhuman.tools/arrival/loader";

const RESOLVE = "ext/toml/resolve";

/** `.toml` → `{ kind: "value" }` DATA. Bound as a `symbol.native` verb (the raw `{ value }`
 *  arm is retired — see ext-yaml.ts's `resolveYaml` note): `require` dispatches its apply
 *  term with `(contents, {path}) → ResolverResult`, raw either way. */
const resolveToml: ContentResolver = (contents) => ({
  kind: "value",
  value: normalizeToJson(parseToml(String(contents))),
});

/** The editor twin of `resolveToml` — see `ext-yaml.ts`'s `typeYaml` for the whole
 *  story (same recovery gap, same fix). */
const typeToml: RequireTypeProvider = (source) => {
  try {
    return valueToTsType(normalizeToJson(parseToml(source)));
  } catch {
    return null;
  }
};

/** See `ext-yaml.ts`'s `yamlHandler` — the exact same bundling rationale. */
export const tomlHandler: ExtensionHandler = { resolve: resolveToml, type: typeToml };

export const arrivalTomlCapability = EnvCapability.define("ext/toml", {
  // Loader first in C3: prelude calls require/register-extension (preludeOnly on loader).
  deps: [arrivalLoaderCapability],
  symbols: (symbol, z) => ({
    [RESOLVE]: symbol.native`ext/toml/resolve: resolves .toml module contents to a ResolverResult (loader registry verb)`(
      { input: [z.schemeValue, z.schemeValue], output: [z.schemeValue] },
      resolveToml as never,
    ),
  }),
  // Bare symbol — `require/register-extension` is a MACRO (unevaluated resolver name).
  prelude: `(require/register-extension ".toml" ${RESOLVE})`,
});
