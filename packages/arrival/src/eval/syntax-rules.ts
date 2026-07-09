// ----------------------------------------------------------------------
// The macro engine — syntax-rules pattern matching + template expansion, and
// the `macroexpand` traversal. Evaluate-free (it rewrites code, it does not run
// it) and carries no module-level global_env edge — lambda/define resolve from
// the runtime env, and the global-env identity check is threaded through
// extract_patterns' `scope` argument by the syntax-rules caller. The 5 exported
// functions are consumed by the `syntax-rules` / `macroexpand` builtins in env/macros.ts.
//
// Attribution: derived from LIPS Scheme (Jakub T. Jankiewicz) — see LICENSE.
//
// Lineage: hygienic macro expansion (Kohlbecker et al., "Hygienic Macro
// Expansion", 1986; Clinger & Rees, "Macros That Work", POPL 1991); R7RS §4.3
// syntax-rules; ellipsis sub-patterns per SRFI-46.
// ----------------------------------------------------------------------
import invariant from "tiny-invariant";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { Environment } from "../Environment.js";
import type { Resolver } from "./Resolver.js";
import type { Capabilities } from "./Capabilities.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { Macro } from "./Macro.js";
import { APair, __tieKnot, concatPair } from "../values/primitives/APair.js";
import { Syntax } from "./Syntax.js";
import { isNumeric } from "../values/numbers.js";
import { DATA } from "../well-known-symbols.js";
import { eqv } from "../values/structural-equal.js";
import { AListAlike, type SchemeValue } from "../values/types.js";
import { ANil, nil } from "../values/primitives/ANil.js";
import { type } from "../utils/typecheck.js";
import { gensym, hidden_prop, is_atom, is_gensym, quote } from "../reader/values-repr.js";

type SchemeFunction = (...args: any[]) => any;

function same_atom(a, b) {
  if (type(a) !== type(b)) {
    return false;
  }
  if (!is_atom(a)) {
    return false;
  }
  if (a instanceof RegExp) {
    return a.source === b.source;
  }
  // Strings (raw or boxed) compare by value — the "friendly" compat layer.
  if (a instanceof AString) {
    return b instanceof AString && a.valueOf() === b.valueOf();
  }
  // Numbers / chars / booleans / nil: atom-grade (eqv?) equality, which lives
  // entirely in the value kernel (instanceof + .equals/__char__/.value).
  // See plan-2026-06-10-algebras-in-entities.md.
  return eqv(a, b);
}

// `concatPair`'s Semigroup contract (list ⋄ list) requires the tail to be list-alike
// (`AListAlike`). A dotted-tail ellipsis template — e.g. `(a ... . b)` matched against
// `(m 1 2 . 3)` — legitimately binds `b` to a bare scalar, so the ellipsis-expansion result
// feeding these tails can be an arbitrary SchemeValue, not a list. Same cons-loop as
// `concatPair` (values/primitives/APair.ts), typed for that wider arbitrary-tail domain
// instead of forcing a scalar into AListAlike.
function concatPairLoose(a: SchemeValue, b: SchemeValue): SchemeValue {
  const cars: SchemeValue[] = [];
  let node: unknown = a;
  while (node instanceof APair) {
    cars.push(node.car);
    node = node.cdr;
  }
  let result: SchemeValue = b;
  for (let i = cars.length; i--; ) {
    result = new APair(CONSTANT_CTX, cars[i], result);
  }
  return result;
}

/** W0 span propagation (PROVENANCE.md §7 span-totality; plan Q6). Expansion-
 *  constructed Pairs carry the TEMPLATE's span: same template node → same span on
 *  every instantiation — exactly the template/instance keying the wireframe (Q8a)
 *  needs, and drill-in points at the form as WRITTEN (in the macro). Pattern-variable
 *  substitutions are call-site Pairs by reference and keep their own call-site spans
 *  untouched. Upgrade path (deferred): an expansion-chain slot recording the call
 *  site per expansion, when a consumer needs both readings at once. Only stamps
 *  Pairs that would otherwise be span-less — never overwrites. */
function carrySpan<T extends SchemeValue>(fresh: T, template: SchemeValue): T {
  if (fresh instanceof APair && fresh.getLocation() === undefined && template instanceof APair) {
    const loc = template.getLocation();
    if (loc !== undefined) fresh.setLocation(loc);
  }
  return fresh;
}

/** carrySpan for a freshly-built SPINE (fromArray/concat): stamps every unlocated
 *  cdr-chain cell, not just the head — repetition output is a list of cells all
 *  minted in one call. Car sub-structures are either template reconstructions
 *  (already stamped at their own sites) or call-site fragments (own spans). */
function carrySpanSpine<T extends SchemeValue>(fresh: T, template: SchemeValue): T {
  let node: unknown = fresh;
  while (node instanceof APair) {
    carrySpan(node, template);
    node = node.cdr;
  }
  return fresh;
}

// ----------------------------------------------------------------------
// ----------------------------------------------------------------------
const recur_guard = -10_000;

export function macro_expand(): SchemeFunction {
  return async function (this: Environment, code: SchemeValue, args: SchemeValue) {
    const env = (args["env"] = this);
    // `bindings` / `names` hold IDENTIFIER NAMES (the `.valueOf()` of bound symbols —
    // `string | symbol`), consulted by `is_macro` via `bindings.includes(name)`. They are
    // not SchemeValues; the pre-union `= any` alias had masked that.
    let bindings: (string | symbol)[] = [];
    const let_macros = new Set(["let", "let*", "letrec"]);
    // lambda/define resolved from the runtime env (whose root is global_env) so
    // the engine carries no module-level global_env edge.
    const lambda = env.get("lambda");
    const define = env.get("define");

    function is_let_macro(symbol: ASymbol) {
      const name = symbol.valueOf();
      return typeof name === "string" && let_macros.has(name);
    }

    function is_procedure(value: unknown, node: APair<any, any>) {
      return value === define && node.cdr instanceof APair && node.cdr.car instanceof APair;
    }

    function is_lambda(value: unknown) {
      return value === lambda;
    }

    function proc_bindings(node: unknown) {
      const names: (string | symbol)[] = [];
      while (true) {
        if (node instanceof ANil) {
          break;
        } else {
          if (node instanceof ASymbol) {
            names.push(node.valueOf());
            break;
          }
          invariant(node instanceof APair, `macroexpand: proc_bindings expected pair got ${type(node)}`);
          invariant(
            node.car instanceof ASymbol,
            `macroexpand: proc_bindings name expected symbol got ${type(node.car)}`,
          );
          names.push(node.car.valueOf());
          node = node.cdr;
        }
      }
      return [...bindings, ...names];
    }

    function let_binding(node: SchemeValue): (string | symbol)[] {
      invariant(node instanceof APair, `macroexpand: let bindings expected pair got ${type(node)}`);
      return [
        ...bindings,
        ...node.to_array(false).map(function (node: unknown) {
          invariant(node instanceof APair, `macroexpand: Invalid let binding expectig pair got ${type(node)}`);
          invariant(node.car instanceof ASymbol, `macroexpand: let binding name expected symbol got ${type(node.car)}`);
          return node.car.valueOf();
        }),
      ];
    }

    // A type guard (not just a boolean): narrows `value` to `Macro | Syntax` so the
    // expander dispatches on the class — Syntax.expand vs Macro.invoke — with no cast.
    function is_macro(name: string | symbol, value: unknown): value is Macro | Syntax {
      // Syntax no longer extends Macro — list both (a Syntax carries __defmacro__ too).
      // `=== true` because Macro.__defmacro__ is optional (boolean | undefined); a type
      // predicate must yield a strict boolean.
      return (
        (value instanceof Macro || value instanceof Syntax) && value.__defmacro__ === true && !bindings.includes(name)
      );
    }

    async function expand_let_binding(node: unknown, n?: number): Promise<SchemeValue> {
      if (node instanceof ANil) {
        return nil;
      }
      invariant(node instanceof APair, `macroexpand: let binding list expected pair got ${type(node)}`);
      const pair = node.car;
      invariant(pair instanceof APair, `macroexpand: let binding expected pair got ${type(pair)}`);
      return carrySpan(
        new APair(
          CONSTANT_CTX,
          carrySpan(new APair(CONSTANT_CTX, pair.car, await traverse(pair.cdr, n ?? -1, env)), pair),
          await expand_let_binding(node.cdr),
        ),
        node,
      );
    }

    async function traverse(node: unknown, n: number, env: Environment): Promise<SchemeValue> {
      if (node instanceof APair && node.car instanceof ASymbol) {
        if (node[DATA]) {
          return node;
        }
        const name = node.car.valueOf();
        const value = env.get(node.car, { throwError: false });
        const is_let = is_let_macro(node.car);

        const is_binding = is_let || is_procedure(value, node) || is_lambda(value);

        const nodeCdr = node.cdr;
        if (is_binding && nodeCdr instanceof APair && nodeCdr.car instanceof APair) {
          let second;
          if (is_let) {
            bindings = let_binding(nodeCdr.car);
            second = await expand_let_binding(nodeCdr.car, n);
          } else {
            bindings = proc_bindings(nodeCdr.car);
            second = nodeCdr.car;
          }
          return carrySpan(
            new APair(CONSTANT_CTX, node.car, carrySpan(new APair(CONSTANT_CTX, second, await traverse(nodeCdr.cdr, n, env)), nodeCdr)),
            node,
          );
        } else if (is_macro(name, value)) {
          // Split by the transformer's HONEST return shape (no flag toggles it):
          // Syntax.expand -> { expr, scope }, re-expanded in its hygiene scope;
          // Macro.invoke -> a replacement FORM, re-expanded in the use env.
          let result: SchemeValue;
          if (value instanceof Syntax) {
            const { expr, scope } = await value.expand(node, { ...args, env });
            if (expr instanceof APair) {
              if ((n !== -1 && n <= 1) || n < recur_guard) {
                return expr;
              }
              if (n !== -1) {
                n = n - 1;
              }
              return traverse(expr, n, scope);
            }
            result = expr;
          } else {
            result = await value.invoke(nodeCdr, { ...args, env }, true);
          }
          if (result instanceof ASymbol) {
            return quote(result);
          }
          if (result instanceof APair) {
            if ((n !== -1 && n <= 1) || n < recur_guard) {
              return result;
            }
            if (n !== -1) {
              n = n - 1;
            }
            return traverse(result, n, env);
          }
          if (is_atom(result)) {
            return result;
          }
        }
      }
      // TODO: CYCLE DETECT
      // traverse is only ever called on a pair (every recursive call is `is_pair`-gated,
      // and the entry points pass forms); an atom reaching here is a structural bug.
      invariant(node instanceof APair, `macroexpand: traverse expected pair got ${type(node)}`);
      let car = node.car;
      if (car instanceof APair) {
        car = await traverse(car, n, env);
      }
      let cdr = node.cdr;
      if (cdr instanceof APair) {
        cdr = await traverse(cdr, n, env);
      }
      return carrySpan(new APair(CONSTANT_CTX, car, cdr), node instanceof APair ? node : nil);
    }

    invariant(code instanceof APair, `macroexpand: expected a form got ${type(code)}`);
    const depth = code.cdr instanceof APair && isNumeric(code.cdr.car) ? Number(code.cdr.car.valueOf()) : -1;
    const expanded = await traverse(code, depth, env);
    invariant(expanded instanceof APair, `macroexpand: expansion did not yield a form`);
    // `quote` only marks pairs/symbols as data (a no-op passthrough for any other datum),
    // so narrow the head to the two shapes it acts on; an atom head returns unchanged.
    const head = expanded.car;
    return head instanceof APair || head instanceof ASymbol ? quote(head) : head;
  };
}

// ----------------------------------------------------------------------
// The hygiene-identity handles injected by the syntax-rules caller (the engine
// references no module-level env): `useResolver` over the USE site, the captured
// `defResolver`, and its `capabilities` (whose `globalRoot` is the unshadowed-base
// identity). Plain JS resolver handles, NOT SchemeValues.
// ----------------------------------------------------------------------
interface HygieneScope {
  useResolver: Resolver;
  defResolver: Resolver;
  capabilities: Capabilities;
}

// The pattern-match accumulator. Its leaf cells hold a HETEROGENEOUS mix the matcher
// reads back through guards — a captured SchemeValue, an ellipsis APair list, a raw JS
// array (nested ellipsis), `nil`, or `null` (empty-ellipsis sentinel) — so the honest
// leaf type is `unknown`, narrowed at each read site (`is_pair`/`is_nil`/`Array.isArray`).
// A binding cell holds MATCHED CODE FRAGMENTS (scheme values); an ELLIPSIS cell additionally
// holds per-repetition ARRAYS (the (x ...) accumulation) and the `null` sentinel ("matched,
// zero repetitions") — never arbitrary host data.
type BindingCell = Record<string | symbol, SchemeValue | SchemeValue[] | null | undefined>;
// The TEMPLATE layer's value domain — plain SchemeValue since the EnvLookup deletion:
// that wrapper (LIPS's `Value`, renamed at the fork) was a truthiness shield letting the
// ellipsis loops' `!== undefined` productive-iteration tests distinguish a captured
// JS-falsy value from "produced nothing". Post bare-value-purge the protected case is
// uninhabited — every template-domain value is a boxed, always-truthy AValue, so
// `undefined` alone marks an unproductive iteration.
type TemplateValue = SchemeValue;
interface MatchBindings {
  "...": { symbols: BindingCell; lists: unknown[] };
  symbols: BindingCell;
}

// Per-recursion matcher state threaded through `traverse`.
interface MatchState {
  ellipsis?: boolean;
  trailing?: boolean;
  pattern_names?: (string | symbol)[];
}

// TODO detect cycles
// ----------------------------------------------------------------------
export function extract_patterns(
  pattern: unknown,
  code: unknown,
  symbols: unknown[],
  ellipsis_symbol: string | ASymbol | RegExp,
  scope: HygieneScope,
) {
  const bindings: MatchBindings = {
    "...": {
      symbols: {}, // symbols ellipsis (x ...)
      lists: [],
    },
    symbols: {},
  };
  const { useResolver, defResolver, capabilities } = scope;
  // pattern_names parameter is used to distinguish
  // multiple matches of ((x ...) ...) against ((1 2 3) (1 2 3))
  // in loop we add x to the list so we know that this is not
  // duplicated ellipsis symbol

  function traverse(pattern: unknown, code: unknown, state: MatchState = {}) {
    const { ellipsis = false, trailing = false, pattern_names = [] } = state;
    if (is_atom(pattern) && !(pattern instanceof ASymbol)) {
      return same_atom(pattern, code);
    }
    if (pattern instanceof ASymbol) {
      const literal = pattern.literal(); // TODO: literal() may be SLOW
      if (symbols.includes(literal)) {
        const codeAsName = code instanceof ASymbol || typeof code === "string" || code instanceof RegExp;
        if (!ASymbol.is(code, literal) && !(codeAsName && ASymbol.is(pattern, code as ASymbol | string | RegExp))) {
          return false;
        }
        // refFrame walks USE-site scope frames THEN capabilities, returning the owning frame
        // (a LexicalScope for a lexical owner, the globalRoot env for an unshadowed builtin).
        // unbound (!ref) and unshadowed-base (=== globalRoot) match; `=== defResolver.scope`
        // compares the captured def frame. A literal shadowed by an intervening user `let`
        // returns that user frame (≠ both) → no match.
        const ref = useResolver.refFrame(literal);
        return !ref || ref === defResolver.scope || ref === capabilities.globalRoot;
      }
    }
    // KNOWN LIMITATION (boxing track S9, deferred — docs/plan-2026-06-10-boxing-track.md
    // R8): vector PATTERNS in syntax-rules reach this array branch. Since the
    // boxing track, a `#(...)` literal parses to a boxed SchemeVector, NOT a raw
    // array — so `Array.isArray` is false for it and a vector-pattern macro fails
    // to match (loud "no matching syntax in macro (#<SchemeVector>)", not silent
    // corruption). Boxing orphans this path. The fix (unwrap SchemeVector →
    // raw array here AND re-box at the template-output sites, which are deeply
    // interleaved with the ellipsis machinery) is high-risk in this fragile
    // matcher and the feature is untested/unused (no chibi/lang vector-pattern
    // test), so it is deferred to a focused session with vector-pattern tests
    // written first. Lists are Pairs (unaffected); only vector patterns regress.
    if (Array.isArray(pattern) && Array.isArray(code)) {
      if (pattern.length === 0 && code.length === 0) {
        return true;
      }
      if (ASymbol.is(pattern[1], ellipsis_symbol)) {
        if (pattern[0] instanceof ASymbol) {
          const name = pattern[0].valueOf();
          if (ellipsis) {
            const count = code.length - 2;
            const array_head = count > 0 ? code.slice(0, count) : code;
            const as_list = APair.fromArray(CONSTANT_CTX, array_head, false);
            bindings["..."].symbols[name] = bindings["..."].symbols[name]
              ? // list-accumulation cell (the array style is the `??= []` cell in the symbol arm)
                concatPair(CONSTANT_CTX, bindings["..."].symbols[name] as SchemeValue, new APair(CONSTANT_CTX, as_list, nil))
              : new APair(CONSTANT_CTX, as_list, nil);
          } else {
            bindings["..."].symbols[name] = APair.fromArray(CONSTANT_CTX, code, false);
          }
        } else if (Array.isArray(pattern[0])) {
          const names = [...pattern_names];
          const new_state = { ...state, pattern_names: names, ellipsis: true };
          if (!code.every((node) => traverse(pattern[0], node, new_state))) {
            return false;
          }
        }
        if (pattern.length > 2) {
          const pat = pattern.slice(2);
          return traverse(pat, code.slice(-pat.length), state);
        }
        return true;
      }
      const first = traverse(pattern[0], code[0], state);
      const rest = traverse(pattern.slice(1), code.slice(1), state);
      return first && rest;
    }
    // pattern (a b (x ...)) and (x ...) match nil
    if (
      pattern instanceof APair &&
      pattern.car instanceof APair &&
      pattern.car.cdr instanceof APair &&
      ASymbol.is(pattern.car.cdr.car, ellipsis_symbol) &&
      code instanceof ANil &&
      pattern.car.car instanceof ASymbol
    ) {
      const name = pattern.car.car.valueOf();
      invariant(!bindings["..."].symbols[name], "syntax: named ellipsis can only appear onces");
      bindings["..."].symbols[name] = code;
    }
    if (pattern instanceof APair && pattern.cdr instanceof APair && ASymbol.is(pattern.cdr.car, ellipsis_symbol)) {
      // pattern (... ???) - SRFI-46
      if (!(pattern.cdr.cdr instanceof ANil) && pattern.cdr.cdr instanceof APair) {
        // if we have (x ... a b) we need to remove two from the end
        const list_len = pattern.cdr.cdr.length();
        // `last_pair()` on a non-empty pair spine only returns via its
        // `!(node.cdr instanceof APair)` arm — reached while `node instanceof APair` still
        // holds — or `undefined` on a cycle; it never returns ANil. The guard below makes
        // that runtime invariant explicit instead of casting the union away.
        const patternLastPair = pattern.last_pair();
        invariant(patternLastPair instanceof APair, "syntax: last_pair of a non-empty pair spine is a pair");
        const improper_list = !(patternLastPair.cdr instanceof ANil);
        if (!(code instanceof APair)) {
          return false;
        }
        let code_len = code.length();
        let list: SchemeValue = code;
        const trailing = improper_list ? 1 : 1;
        while (code_len - trailing > list_len) {
          invariant(list instanceof APair, "syntax: trailing-trim walk stays within the counted pair prefix");
          list = list.cdr;
          code_len--;
        }
        invariant(list instanceof APair, "syntax: trailing-trim walk stays within the counted pair prefix");
        const rest = list.cdr;
        // FRESH-PREFIX split (readonly-slot contract): the old `list.cdr = nil` SEVERED the
        // user's input form in place — and never restored it, so a matched form's spine stayed
        // corrupted in the source AST after expansion (a latent LIPS-heritage bug the readonly
        // contract surfaced). Build the head segment as a fresh spine instead: elements SHARED
        // (provenance preserved), spine fresh, the input form untouched.
        const prefixEls: SchemeValue[] = [];
        let n: SchemeValue = code;
        while (true) {
          invariant(n instanceof APair, "syntax: prefix walk stays within code's pair spine");
          prefixEls.push(n.car);
          if (n === list) break;
          n = n.cdr;
        }
        code = APair.fromArray(CONSTANT_CTX, prefixEls, false) as AListAlike;
        const new_sate = { ...state, trailing: improper_list };
        if (!traverse(pattern.cdr.cdr, rest, new_sate)) {
          return false;
        }
      }
      if (pattern.car instanceof ASymbol) {
        const name = pattern.car.__name__;
        if (bindings["..."].symbols[name] && !pattern_names.includes(name) && !ellipsis) {
          throw new Error("syntax: named ellipsis can only appear onces");
        }
        if (code instanceof ANil) {
          bindings["..."].symbols[name] = ellipsis ? nil : null;
        } else if (code instanceof APair && (code.car instanceof APair || code.car instanceof ANil)) {
          if (ellipsis) {
            if (bindings["..."].symbols[name]) {
              let node = bindings["..."].symbols[name] as SchemeValue; // list-accumulation cell
              node =
                node instanceof ANil
                  ? new APair(CONSTANT_CTX, nil, new APair(CONSTANT_CTX, code as SchemeValue, nil))
                  : concatPair(CONSTANT_CTX, node, new APair(CONSTANT_CTX, code as SchemeValue, nil));
              bindings["..."].symbols[name] = node;
            } else {
              bindings["..."].symbols[name] = new APair(CONSTANT_CTX, code, nil);
            }
          } else {
            bindings["..."].symbols[name] = new APair(CONSTANT_CTX, code, nil);
          }
        } else {
          if (code instanceof APair) {
            // cons (a . b) => (var ... . x)
            if (!(code.cdr instanceof APair) && !(code.cdr instanceof ANil)) {
              if (pattern.cdr.cdr instanceof ANil) {
                return false;
              } else if (!bindings["..."].symbols[name]) {
                bindings["..."].symbols[name] = new APair(CONSTANT_CTX, code.car, nil);
                return traverse(pattern.cdr.cdr, code.cdr, state);
              }
            }
            // code as improper list. `last_pair()` on a non-empty pair spine is always a
            // pair (see the identical guard above) or `undefined` on a cycle — never ANil.
            const last_pair = code.last_pair();
            invariant(last_pair instanceof APair, "syntax: last_pair of a non-empty pair spine is a pair");
            if (!(last_pair.cdr instanceof ANil)) {
              if (pattern.cdr.cdr instanceof ANil) {
                // case (a ...) for (a b . x)
                return false;
              } else {
                // case (a ... . b) for (a b . x)
                const copy = code.clone();
                invariant(copy instanceof APair, "syntax: clone of a non-empty pair spine is a pair");
                const copyLastPair = copy.last_pair();
                invariant(copyLastPair instanceof APair, "syntax: last_pair of a non-empty pair spine is a pair");
                // Ellipsis surgery on a PRIVATE clone — the knot door's third named consumer.
                __tieKnot(copyLastPair, "cdr", nil);
                bindings["..."].symbols[name] = copy;
                return traverse(pattern.cdr.cdr, last_pair.cdr, state);
              }
            }
            pattern_names.push(name);
            if (bindings["..."].symbols[name]) {
              const node = bindings["..."].symbols[name] as SchemeValue; // list-accumulation cell
              bindings["..."].symbols[name] = concatPair(CONSTANT_CTX, node, new APair(CONSTANT_CTX, code as SchemeValue, nil));
            } else {
              bindings["..."].symbols[name] = new APair(CONSTANT_CTX, code as SchemeValue, nil);
            }
          } else if (
            pattern.car instanceof ASymbol &&
            pattern.cdr instanceof APair &&
            ASymbol.is(pattern.cdr.car, ellipsis_symbol)
          ) {
            // empty ellipsis with rest  (a b ... . d) #290
            bindings["..."].symbols[name] = null;
            return traverse(pattern.cdr.cdr, code, state);
          } else {
            return false;
            //bindings['...'].symbols[name] = code;
          }
        }
        return true;
      } else if (pattern.car instanceof APair) {
        var names = [...pattern_names];
        if (code instanceof ANil) {
          bindings["..."].lists.push(nil);
          return true;
        }
        let node = code;
        const new_state = { ...state, pattern_names: names, ellipsis: true };
        while (node instanceof APair) {
          if (!traverse(pattern.car, node.car, new_state)) {
            return false;
          }
          node = node.cdr;
        }
        return true;
      }
      if (Array.isArray(pattern.car)) {
        var names = [...pattern_names];
        let node = code;
        const new_state = { ...state, pattern_names: names, ellipsis: true };
        while (node instanceof APair) {
          if (!traverse(pattern.car, node.car, new_state)) {
            return false;
          }
          node = node.cdr;
        }
        return true;
      }
      return false;
    }
    if (pattern instanceof ASymbol) {
      invariant(!ASymbol.is(pattern, ellipsis_symbol), "syntax: invalid usage of ellipsis");
      const name = pattern.__name__;
      if (symbols.includes(name)) {
        return true;
      }
      if (ellipsis) {
        const cell = (bindings["..."].symbols[name] ??= [] as SchemeValue[]);
        invariant(Array.isArray(cell), "syntax: ellipsis binding cell must be an array");
        cell.push(code as SchemeValue);
      } else {
        bindings.symbols[name] = code as SchemeValue;
      }
      return true;
    }
    if (pattern instanceof APair && code instanceof APair) {
      const patternCar = pattern.car;
      const patternCdr = pattern.cdr;
      if (trailing && patternCar instanceof ASymbol && patternCdr instanceof ASymbol) {
        // handle (x ... y . z)
        if (!(code.cdr instanceof ANil)) {
          return false;
        }
        const car = patternCar.valueOf();
        const cdr = patternCdr.valueOf();
        bindings.symbols[car] = code.car;
        bindings.symbols[cdr] = nil;
        return true;
        //return is_pair(code.cdr) && code.cdr.length() > 1;
      }
      if (
        code.cdr instanceof ANil && // last item in in call using in recursive calls on
        // last element of the list
        // case of pattern (p . rest) and code (0)
        patternCar instanceof ASymbol &&
        patternCdr instanceof ASymbol
      ) {
        // fix for SRFI-26 in recursive call of (b) ==> (<> . x)
        // where <> is symbol
        if (!traverse(patternCar, code.car, state)) {
          return false;
        }
        let name: string | symbol = patternCdr.valueOf();
        if (!(name in bindings.symbols)) {
          bindings.symbols[name] = nil;
        }
        name = patternCar.valueOf();
        if (!(name in bindings.symbols)) {
          bindings.symbols[name] = code.car;
        }
        return true;
      }
      // case (x y) ===> (var0 var1 ... warn) where var1 match nil
      // trailing: true start processing of (var ... x . y)
      if (
        pattern.cdr instanceof APair &&
        pattern.cdr.cdr instanceof APair &&
        pattern.cdr.car instanceof ASymbol &&
        ASymbol.is(pattern.cdr.cdr.car, ellipsis_symbol) &&
        pattern.cdr.cdr.cdr instanceof APair &&
        !ASymbol.is(pattern.cdr.cdr.cdr.car, ellipsis_symbol) &&
        traverse(pattern.car, code.car, state) &&
        traverse(pattern.cdr.cdr.cdr, code.cdr, { ...state, trailing: true })
      ) {
        const name = pattern.cdr.car.__name__;
        if (symbols.includes(name)) {
          return true;
        }
        bindings["..."].symbols[name] = null;
        return true;
      }
      const car = traverse(pattern.car, code.car, state);
      const cdr = traverse(pattern.cdr, code.cdr, state);
      if (car && cdr) {
        return true;
      }
    } else if (pattern instanceof ANil && (code instanceof ANil || code === undefined)) {
      // undefined is case when you don't have body ...
      // and you do recursive call
      return true;
    } else {
      // pattern (...)
      invariant(
        !(pattern instanceof APair) || !(pattern.car instanceof APair) || !ASymbol.is(pattern.car.car, ellipsis_symbol),
        "syntax: invalid usage of ellipsis",
      );
      return false;
    }
  }

  if (traverse(pattern, code)) {
    return bindings;
  }
}

// ----------------------------------------------------------------------
// Restore hygiene-renamed gensyms to their literal symbols, but ONLY in DATA
// positions — under quote/quasiquote, EXCLUDING unquote(-splicing) holes (which
// are code). A template identifier under quote is DATA, not a reference, so hygiene
// must not rename it (standard expander behaviour). The renamer over-renames every
// identifier; this single pass un-renames the data positions of the transcribed
// FORM, so quote yields the literal symbol with no post-eval fixup.
//
// Runs on the FORM, not the evaluated result: a result-side fixup would have to
// ride the trampoline as an onResolve, which composes through a tail chain ->
// O(depth) for a deep macro tail loop. Restoring the form once per expansion is
// O(form) and never composes, so a macro in tail position keeps O(1) TCO.
// ----------------------------------------------------------------------
export function restore_data_gensyms(node, gensyms) {
  if (gensyms.length === 0) return node;
  const restore = (sym) => {
    const r = gensyms.find((g) => g.gensym === sym);
    return r ? new ASymbol(CONSTANT_CTX, r.name) : sym;
  };
  function walk(n, data) {
    if (n instanceof ASymbol) {
      return data ? restore(n) : n;
    }
    if (n instanceof APair) {
      const head = n.car;
      let childData = data;
      if (head instanceof ASymbol) {
        const lit = head.literal();
        if (lit === "quote" || lit === "quasiquote") childData = true;
        else if (lit === "unquote" || lit === "unquote-splicing") childData = false;
      }
      // head resolves in the CURRENT context (it is the operator); operands take childData.
      return carrySpan(new APair(CONSTANT_CTX, walk(head, data), walk(n.cdr, childData)), n);
    }
    return n;
  }
  return walk(node, false);
}

// The renamed-gensym record kept so `restore_data_gensyms` can un-rename DATA positions.
interface GensymRecord {
  name: string | symbol;
  gensym: ASymbol;
}

// `transform_syntax`'s options — the template (`expr`), the matcher output (`bindings`),
// the literal-`symbols` name-list, the def-time syntax-child RESOLVER (`scope`), the
// `names` accumulator, and the `ellipsis` marker. These are plain JS handles, not a SchemeValue.
interface TransformOptions {
  bindings: MatchBindings;
  expr: SchemeValue;
  scope: Resolver;
  symbols: unknown[];
  names: GensymRecord[];
  ellipsis: string | ASymbol;
}

// ----------------------------------------------------------------------
export function transform_syntax({
  bindings,
  expr,
  scope: defChild,
  symbols,
  names,
  ellipsis: ellipsis_symbol,
}: TransformOptions) {
  // `scope` is the def-time syntax-child RESOLVER (`defResolver.child("syntax")`); the
  // engine consults its refFrame/lookupSettled/define instead of raw env .ref/.get/.set.
  const gensyms: Record<string | symbol, ASymbol> = {};

  function transform(symbol: SchemeValue): SchemeValue {
    invariant(symbol instanceof ASymbol, `syntax: internal error, need symbol got ${type(symbol)}`);
    const name = symbol.valueOf();
    invariant(name !== ellipsis_symbol, "syntax: internal error, ellipsis not transformed");
    // symbols are gensyms from nested syntax-rules
    const n_type = typeof name;
    if (["string", "symbol"].includes(n_type)) {
      if (name in bindings.symbols) {
        return bindings.symbols[name] as SchemeValue; // plain cell — never an array/null (ellipsis-only)
      } else if (typeof name === "string" && /\./.test(name)) {
        // calling method on pattern symbol #83
        const parts = name.split(".");
        const first = parts[0];
        if (first in bindings.symbols) {
          return APair.fromArray(CONSTANT_CTX, [
            new ASymbol(CONSTANT_CTX, "."),
            bindings.symbols[first] as SchemeValue, // plain cell — never an array/null (ellipsis-only)
            ...parts.slice(1).map((x) => new AString(CONSTANT_CTX, x)),
          ]);
        }
      }
    }
    if (symbols.includes(name)) {
      return symbol;
    }
    return rename(name, symbol);
  }

  function rename(name: string | symbol, symbol: ASymbol | string | symbol) {
    if (!gensyms[name]) {
      // Hygiene identity: does `name` resolve to a frame? refFrame-truthiness ≡ the old
      // scope.ref chain-walk (own bindings, no resolvers/synth, scope-then-capabilities).
      // refFrame keys by string; a JS-symbol name (gensym from nested syntax-rules) never
      // owns a frame, so it resolves not-found and falls through to the relit path below.
      const found = typeof name === "string" ? defChild.refFrame(name) : undefined;
      // nested syntax-rules needs original symbol to get renamed again
      if (typeof name === "symbol" && !found && symbol instanceof ASymbol) {
        name = symbol.literal();
      }
      if (gensyms[name]) {
        return gensyms[name];
      }
      const gensym_name = gensym(name);
      // Copy the bound value (if any) onto the gensym so the expansion resolves it. This unifies
      // the old ref?get(name):get(name,{throwError:false}) split — the ref-truthy value is never
      // undefined, so "set iff present" matches both arms. lookupSettled is settled (patch_value),
      // resolver-aware, NON-synth and non-throwing — exactly the old scope.get(name,{throwError:false}).
      const value = defChild.lookupSettled(name);
      if (value !== undefined) {
        defChild.define(gensym_name, value);
      }
      // keep names so they can be restored after evaluation
      // if there are free symbols as output
      // kind of hack
      names.push({
        name,
        gensym: gensym_name,
      });
      gensyms[name] = gensym_name;
      // we need to check if name is a string, because it can be
      // gensym from nested syntax-rules
      if (typeof name === "string" && /\./.test(name)) {
        const [first, ...rest] = name.split(".").filter(Boolean);
        // save JavaScript dot notation for Env::get
        if (gensyms[first]) {
          hidden_prop(gensym_name, "__object__", [gensyms[first], ...rest]);
        }
      }
    }
    return gensyms[name];
  }

  function transform_ellipsis_expr(
    expr: SchemeValue,
    bindings: BindingCell,
    state: { nested: boolean },
    next: (name: string | symbol, value: unknown) => void = () => {},
  ): TemplateValue | undefined {
    if (Array.isArray(expr) && expr.length === 0) {
      return expr;
    }
    if (expr instanceof ASymbol) {
      const name = expr.valueOf();
      const bound = bindings[name];
      if (is_gensym(expr) && !bound) {
        // name = expr.literal();
      }
      if (bound) {
        if (bound instanceof APair) {
          if (state.nested) {
            if (bound.car instanceof APair) {
              if (bound.car.cdr instanceof ANil) {
                return bound.car.car;
              }
              next(name, new APair(CONSTANT_CTX, bound.car.cdr, nil));
            }
            return bound.car;
          }
          if (bound.cdr instanceof ANil) {
            return bound.car;
          }
          next(name, bound.cdr);
        } else if (Array.isArray(bound)) {
          next(name, bound.slice(1));
          return bound[0];
        }
      }
      return transform(expr);
    }

    if (expr instanceof APair) {
      const first = expr.car;
      const second = expr.cdr instanceof APair && expr.cdr.car;
      if (first instanceof ASymbol && ASymbol.is(second, ellipsis_symbol)) {
        const name = first.valueOf();
        const item = bindings[name];
        if (item === null) {
          return;
        } else if (name in bindings) {
          if (item instanceof APair) {
            const rest_expr = expr.cdr instanceof APair ? expr.cdr.cdr : nil;
            if (state.nested) {
              if (!(item.cdr instanceof ANil)) {
                next(name, item.cdr);
              }
              // Dispatch on the runtime shape of `car`, not the template's
              // shape (`is_array` is about `expr`). A JS-array `car` concats
              // with Array.prototype.concat; a pair `car` concats with
              // concatPair. Discriminating on `car` keeps a pair from ever
              // reaching `.concat` (which APair does not have → throw).
              if (!(rest_expr instanceof ANil) && item.car instanceof APair) {
                return carrySpanSpine(concatPairLoose(item.car, transform_ellipsis_expr(rest_expr, bindings, state, next) as SchemeValue), expr);
              }
              return item.car;
            } else if (item.car instanceof APair) {
              if (!(item.car.cdr instanceof ANil)) {
                next(name, new APair(CONSTANT_CTX, item.car.cdr, item.cdr));
              }
              return item.car.car;
            } else if (item.cdr instanceof ANil) {
              return item.car;
            } else if (expr instanceof APair) {
              const last_pair = expr.last_pair();
              invariant(last_pair instanceof APair, "syntax: last_pair of a non-empty pair spine is a pair");
              if (last_pair.cdr instanceof ASymbol) {
                next(name, item.last_pair());
                return item.car;
              }
            }
          }
          return item as TemplateValue;
        }
      }

      return carrySpan(
        new APair(
          CONSTANT_CTX,
          transform_ellipsis_expr(first, bindings, state, next) as SchemeValue,
          transform_ellipsis_expr(expr.cdr, bindings, state, next) as SchemeValue,
        ),
        expr,
      );
    }
    return expr;
  }

  function have_binding(binding: Record<string | symbol, unknown>, skip_nulls = false) {
    const values = Object.values(binding);
    const symbols = Object.getOwnPropertySymbols(binding);
    if (symbols.length > 0) {
      values.push(...symbols.map((x) => binding[x]));
    }
    return (
      values.length > 0 &&
      values.every((x) => {
        if (x === null) {
          return !skip_nulls;
        }
        return x instanceof APair || x instanceof ANil;
      })
    );
  }

  function get_names(object) {
    return [...Object.keys(object), ...Object.getOwnPropertySymbols(object)];
  }

  function traverse(expr: SchemeValue, { disabled }: { disabled?: boolean } = {}): SchemeValue {
    if (expr instanceof APair) {
      const first = expr.car;
      // Derive both off ONE narrowed handle — `second`/`rest_second` exist iff the cdr is a
      // pair, and TS threads that through the optional chain (the old two-let form tripped
      // use-before-assign at every read).
      const cdrPair = expr.cdr instanceof APair ? expr.cdr : undefined;
      const second = cdrPair?.car;
      const rest_second = cdrPair?.cdr;
      // escape ellispsis from R7RS e.g. (... ...): the escape form is
      // `(... <template>)`, so `first.cdr` must itself be a pair carrying
      // <template> in its car. Guard it before reading `.car` — a bare
      // `(...)` would leave `first.cdr` as nil, whose `.car` is undefined.
      if (!disabled && first instanceof APair && ASymbol.is(first.car, ellipsis_symbol) && first.cdr instanceof APair) {
        return carrySpan(new APair(CONSTANT_CTX, first.cdr.car, expr instanceof APair ? traverse(expr.cdr) : nil), expr);
      }
      if (second && ASymbol.is(second, ellipsis_symbol) && !disabled) {
        const symbols = bindings["..."].symbols;
        // skip expand list of pattern was (x y ... z)
        // and code was (x z) so y == null
        const values = Object.values(symbols);
        if (values.length > 0 && values.every((x) => x === null)) {
          return traverse(rest_second as SchemeValue, { disabled });
        }
        const keys = get_names(symbols);
        // case of list as first argument ((x . y) ...) or (x ... ...)
        // we need to recursively process the list
        // if we have pattern (_ (x y z ...) ...) and code (foo (1 2) (1 2))
        // x an y will be arrays of [1 1] and [2 2] and z will be array
        // of rest, x will also have it's own mapping to 1 and y to 2
        // in case of usage outside of ellipsis list e.g.: (x y)
        const is_spread =
          first instanceof ASymbol && rest_second instanceof APair && ASymbol.is(rest_second.car, ellipsis_symbol);
        if (first instanceof APair || is_spread) {
          // lists is free ellipsis on pairs ((???) ...)
          // TODO: will this work in every case? Do we need to handle
          // nesting here?
          if (bindings["..."].lists[0] instanceof ANil) {
            if (!is_spread) {
              return traverse(rest_second as SchemeValue, { disabled });
            }
            return nil;
          }
          let new_expr = first;
          if (is_spread) {
            // TODO: array
            new_expr = carrySpan(new APair(CONSTANT_CTX, first, new APair(CONSTANT_CTX, second, nil)), expr);
          }
          let result: SchemeValue;
          if (keys.length > 0) {
            let bind: BindingCell = { ...symbols };
            result = nil;
            while (true) {
              if (!have_binding(bind)) {
                break;
              }
              const new_bind: BindingCell = {};
              const next = (key: string | symbol, value: unknown) => {
                // ellipsis decide if what should be the next value
                // there are two cases ((a . b) ...) and (a ...)
                new_bind[key] = value as SchemeValue;
              };
              let car = transform_ellipsis_expr(new_expr, bind, { nested: true }, next);
              // undefined can be null caused by null binding
              // on empty ellipsis
              if (car !== undefined) {
                if (is_spread) {
                  result = result instanceof ANil ? (car as SchemeValue) : carrySpanSpine(concatPairLoose(result, car as SchemeValue), expr);
                } else {
                  result = carrySpan(new APair(CONSTANT_CTX, car as SchemeValue, result), expr);
                }
              }
              bind = new_bind;
            }
            if (result instanceof APair && !is_spread) {
              result = carrySpanSpine(APair.fromArray(CONSTANT_CTX, result.to_array(false).reverse(), false), expr);
            }
            // case of (list) ... (rest code)

            if (
              expr instanceof APair &&
              expr.cdr instanceof APair &&
              !(expr.cdr.cdr instanceof ANil) &&
              expr.cdr.cdr instanceof APair &&
              !ASymbol.is(expr.cdr.cdr.car, ellipsis_symbol)
            ) {
              const rest = traverse(expr.cdr.cdr, { disabled });
              return concatPairLoose(result, rest);
            }
            return result;
          } else {
            const car = transform_ellipsis_expr(first, symbols, {
              nested: true,
            });
            if (car) {
              return carrySpan(new APair(CONSTANT_CTX, car, nil), expr);
            }
            return nil;
          }
        } else if (first instanceof ASymbol) {
          if (rest_second instanceof APair && ASymbol.is(rest_second.car, ellipsis_symbol)) {
            // case (x ... ...)
          } else {
          }
          // case: (x ...)
          const name = first.__name__;
          let bind: BindingCell = { [name]: symbols[name] };
          const is_null = symbols[name] === null;
          let result: SchemeValue = nil;
          while (true) {
            if (!have_binding(bind, true)) {
              break;
            }
            const new_bind: BindingCell = {};
            const next = (key: string | symbol, value: unknown) => {
              new_bind[key] = value as SchemeValue;
            };
            const value = transform_ellipsis_expr(expr, bind, { nested: false }, next);
            if (value !== undefined) {
              result = carrySpan(new APair(CONSTANT_CTX, value as SchemeValue, result), expr);
            }
            bind = new_bind;
          }
          if (result instanceof APair) {
            result = carrySpanSpine(APair.fromArray(CONSTANT_CTX, result.to_array(false).reverse(), false), expr);
          }
          // case if (x ... y ...) second spread is not processed
          // and (??? . x) last symbol
          // by ellipsis transformation
          const exprCdr = expr instanceof APair ? expr.cdr : nil;
          if (exprCdr instanceof APair && (exprCdr.cdr instanceof APair || exprCdr.cdr instanceof ASymbol)) {
            const node = traverse(exprCdr.cdr, { disabled });
            if (is_null) {
              return node;
            }
            result = result instanceof ANil ? node : carrySpanSpine(concatPairLoose(result as SchemeValue, node), expr);
          }
          return result;
        }
      }
      const head = traverse(first, { disabled });
      let rest: SchemeValue;
      let is_syntax = false;
      if (first instanceof ASymbol) {
        const value = defChild.lookupSettled(first);
        is_syntax = value instanceof Macro && value.__name__ === "syntax-rules";
      }
      if (is_syntax && expr instanceof APair && expr.cdr instanceof APair) {
        const exprCdr = expr.cdr;
        rest =
          exprCdr.car instanceof ASymbol
            ? carrySpan(
                new APair(
                  CONSTANT_CTX,
                  traverse(exprCdr.car, { disabled }),
                  exprCdr.cdr instanceof APair
                    ? carrySpan(
                        new APair(
                          CONSTANT_CTX,
                          exprCdr.cdr.cdr instanceof APair ? exprCdr.cdr.cdr.car : nil,
                          traverse(exprCdr.cdr.cdr instanceof APair ? exprCdr.cdr.cdr.cdr : nil, { disabled }),
                        ),
                        exprCdr.cdr,
                      )
                    : nil,
                ),
                exprCdr,
              )
            : carrySpan(new APair(CONSTANT_CTX, exprCdr.car, traverse(exprCdr.cdr, { disabled })), exprCdr);
      } else {
        rest = expr instanceof APair ? traverse(expr.cdr, { disabled }) : nil;
      }
      return carrySpan(new APair(CONSTANT_CTX, head, rest), expr);
    }
    if (expr instanceof ASymbol) {
      if (disabled && ASymbol.is(expr, ellipsis_symbol)) {
        return expr;
      }
      const symbols = Object.keys(bindings["..."].symbols);
      const name = expr.literal(); // TODO: slow
      invariant(!symbols.includes(name), `syntax-rules: missing ellipsis symbol next to name \`${name}'`);
      const value = transform(expr);
      if (value !== undefined) {
        return value;
      }
    }
    return expr;
  }

  return traverse(expr, {});
}
