// ----------------------------------------------------------------------
// The macro engine — syntax-rules pattern matching + template expansion, and
// the `macroexpand` traversal. Extracted from lips.ts (keystone K3): this is
// evaluate-free (it rewrites code, it does not run it) and carries no
// module-level global_env edge — lambda/define resolve from the runtime env,
// and the global-env identity check is threaded through extract_patterns'
// `scope` argument by the syntax-rules caller. The 5 exported functions are
// consumed by the `syntax-rules` / `macroexpand` builtins in lips.ts.
//
// Attribution: derived from LIPS Scheme (Jakub T. Jankiewicz) — see LICENSE.
//
// Lineage: hygienic macro expansion (Kohlbecker et al., "Hygienic Macro
// Expansion", 1986; Clinger & Rees, "Macros That Work", POPL 1991); R7RS §4.3
// syntax-rules; ellipsis sub-patterns per SRFI-46.
// ----------------------------------------------------------------------
import invariant from "tiny-invariant";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { EnvLookup } from "../EnvLookup.js";
import { Environment } from "../Environment.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { Macro } from "./Macro.js";
import { APair, concatPair } from "../values/primitives/APair.js";
import { Syntax } from "./Syntax.js";
import { is_nil, is_pair } from "./guards.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import { isNumeric } from "../values/numbers.js";
import { DATA } from "../well-known-symbols.js";
import { eqv } from "../values/structural-equal.js";
import { type SchemeValue } from "../values/types.js";
import { nil } from "../values/primitives/ANil.js";
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
  if (AString.isString(a)) {
    return AString.isString(b) && a.valueOf() === b.valueOf();
  }
  // Numbers / chars / booleans / nil: atom-grade (eqv?) equality, which lives
  // entirely in the value kernel (instanceof + .equals/__char__/.value). This
  // replaces the old `equal()` helper whose is_function branch dragged `unbind`
  // — the macro engine's last tendril into lips's structural-equality switch.
  // (The algebras-in-entities migration will fold this into each type's own
  // arrival/tagless-final/equals — see plan-2026-06-10-algebras-in-entities.md.)
  return eqv(a, b);
}

// ----------------------------------------------------------------------
// ----------------------------------------------------------------------
const recur_guard = -10_000;

export function macro_expand(): SchemeFunction {
  return async function (this: Environment, code: SchemeValue, args: SchemeValue) {
    const env = (args["env"] = this);
    let bindings: SchemeValue[] = [];
    const let_macros = new Set(["let", "let*", "letrec"]);
    // lambda/define resolved from the runtime env (whose root is global_env) so
    // the engine carries no module-level global_env edge — see K3 extraction.
    const lambda = env.get("lambda");
    const define = env.get("define");

    function is_let_macro(symbol) {
      const name = symbol.valueOf();
      return let_macros.has(name);
    }

    function is_procedure(value, node) {
      return value === define && is_pair(node.cdr.car);
    }

    function is_lambda(value) {
      return value === lambda;
    }

    function proc_bindings(node: SchemeValue) {
      const names: SchemeValue[] = [];
      while (true) {
        if (is_nil(node)) {
          break;
        } else {
          if (node instanceof ASymbol) {
            names.push(node.valueOf());
            break;
          }
          names.push((node.car as SchemeValue).valueOf());
          node = node.cdr;
        }
      }
      return [...bindings, ...names];
    }

    function let_binding(node) {
      return [
        ...bindings,
        ...node.to_array(false).map(function (node: SchemeValue) {
          invariant(is_pair(node), `macroexpand: Invalid let binding expectig pair got ${type(node)}`);
          return (node.car as SchemeValue).valueOf();
        }),
      ];
    }

    // A type guard (not just a boolean): narrows `value` to `Macro | Syntax` so the
    // expander dispatches on the class — Syntax.expand vs Macro.invoke — with no cast.
    function is_macro(name: string | symbol, value: SchemeValue): value is Macro | Syntax {
      // Syntax no longer extends Macro — list both (a Syntax carries __defmacro__ too).
      // `=== true` because Macro.__defmacro__ is optional (boolean | undefined); a type
      // predicate must yield a strict boolean.
      return (value instanceof Macro || value instanceof Syntax) && value.__defmacro__ === true && !bindings.includes(name);
    }

    async function expand_let_binding(node: SchemeValue, n?: number): Promise<SchemeValue> {
      if (is_nil(node)) {
        return nil;
      }
      const pair = node.car;
      return new APair(CONSTANT_CTX, new APair(CONSTANT_CTX, pair.car, await traverse(pair.cdr, n ?? -1, env)), await expand_let_binding(node.cdr));
    }

    async function traverse(node: SchemeValue, n: number, env: Environment): Promise<SchemeValue> {
      if (is_pair(node) && node.car instanceof ASymbol) {
        if (node[DATA]) {
          return node;
        }
        const name = node.car.valueOf();
        const value = env.get(node.car, { throwError: false });
        const is_let = is_let_macro(node.car);

        const is_binding = is_let || is_procedure(value, node) || is_lambda(value);

        const nodeCdr = node.cdr as SchemeValue;
        if (is_binding && is_pair(nodeCdr.car)) {
          let second;
          if (is_let) {
            bindings = let_binding(nodeCdr.car);
            second = await expand_let_binding(nodeCdr.car, n);
          } else {
            bindings = proc_bindings(nodeCdr.car);
            second = nodeCdr.car;
          }
          return new APair(CONSTANT_CTX, node.car, new APair(CONSTANT_CTX, second, await traverse(nodeCdr.cdr, n, env)));
        } else if (is_macro(name, value)) {
          // Split by the transformer's HONEST return shape (no flag toggles it):
          // Syntax.expand -> { expr, scope }, re-expanded in its hygiene scope;
          // Macro.invoke -> a replacement FORM, re-expanded in the use env.
          let result: SchemeValue;
          if (value instanceof Syntax) {
            const { expr, scope } = await value.expand(node, { ...args, env });
            if (is_pair(expr)) {
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
          if (is_pair(result)) {
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
      let car = node.car;
      if (is_pair(car)) {
        car = await traverse(car, n, env);
      }
      let cdr = node.cdr;
      if (is_pair(cdr)) {
        cdr = await traverse(cdr, n, env);
      }
      return new APair(CONSTANT_CTX, car, cdr);
    }

    if (is_pair(code.cdr) && isNumeric(code.cdr.car)) {
      return quote((await traverse(code, code.cdr.car.valueOf(), env)).car);
    }
    return quote((await traverse(code, -1, env)).car);
  };
}

// ----------------------------------------------------------------------
// :: for usage in syntax-rule when pattern match it will return
// :: list of bindings from code that match the pattern
// :: TODO detect cycles
// ----------------------------------------------------------------------
export function extract_patterns(
  pattern: SchemeValue,
  code: SchemeValue,
  symbols: SchemeValue,
  ellipsis_symbol: SchemeValue,
  scope: SchemeValue = {},
) {
  const bindings: SchemeValue = {
    "...": {
      symbols: {} as SchemeValue, // symbols ellipsis (x ...)
      lists: [] as SchemeValue[],
    },
    symbols: {} as SchemeValue,
  };
  // The hygiene-identity handles, injected by the syntax-rules caller (the engine references
  // no module-level env): `useResolver` over the USE site, the captured `defResolver`, and its
  // `capabilities` (whose `globalRoot` is the unshadowed-base identity). See K3 + P3 3b.2.
  const { useResolver, defResolver, capabilities } = scope;
  // pattern_names parameter is used to distinguish
  // multiple matches of ((x ...) ...) against ((1 2 3) (1 2 3))
  // in loop we add x to the list so we know that this is not
  // duplicated ellipsis symbol

  function traverse(pattern: SchemeValue, code: SchemeValue, state: SchemeValue = {}) {
    const { ellipsis = false, trailing = false, pattern_names = [] } = state;
    if (is_atom(pattern) && !(pattern instanceof ASymbol)) {
      return same_atom(pattern, code);
    }
    if (pattern instanceof ASymbol) {
      const literal = pattern.literal(); // TODO: literal() may be SLOW
      if (symbols.includes(literal)) {
        if (!ASymbol.is(code, literal) && !ASymbol.is(pattern, code)) {
          return false;
        }
        // refFrame walks USE-site scope frames THEN capabilities, returning the owning frame
        // (a LexicalScope for a lexical owner, the globalRoot env for an unshadowed builtin).
        // unbound (!ref) and unshadowed-base (=== globalRoot) match as before; `=== defResolver.scope`
        // compares the captured def frame. A literal shadowed by an intervening user `let` returns
        // that user frame (≠ both) → no match, as today. (P3 3b.2.)
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
            if (bindings["..."].symbols[name]) {
              bindings["..."].symbols[name] = concatPair(CONSTANT_CTX, 
                bindings["..."].symbols[name],
                new APair(CONSTANT_CTX, as_list, nil),
              );
            } else {
              bindings["..."].symbols[name] = new APair(CONSTANT_CTX, as_list, nil);
            }
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
      is_pair(pattern) &&
      is_pair(pattern.car) &&
      is_pair(pattern.car.cdr) &&
      ASymbol.is(pattern.car.cdr.car, ellipsis_symbol)
    ) {
      if (is_nil(code)) {
        if (pattern.car.car instanceof ASymbol) {
          const name = pattern.car.car.valueOf();
          invariant(!bindings["..."].symbols[name], "syntax: named ellipsis can only appear onces");
          bindings["..."].symbols[name] = code;
        }
      }
    }
    if (is_pair(pattern) && is_pair(pattern.cdr) && ASymbol.is(pattern.cdr.car, ellipsis_symbol)) {
      // pattern (... ???) - SRFI-46
      if (!is_nil(pattern.cdr.cdr) && is_pair(pattern.cdr.cdr)) {
        // if we have (x ... a b) we need to remove two from the end
        const list_len = pattern.cdr.cdr.length();
        const improper_list = !is_nil(pattern.last_pair()!.cdr);
        if (!is_pair(code)) {
          return false;
        }
        let code_len = code.length();
        let list = code;
        const trailing = improper_list ? 1 : 1;
        while (code_len - trailing > list_len) {
          list = list.cdr as APair;
          code_len--;
        }
        const rest = list.cdr;
        list.cdr = nil;
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
        if (is_nil(code)) {
          if (ellipsis) {
            bindings["..."].symbols[name] = nil;
          } else {
            bindings["..."].symbols[name] = null;
          }
        } else if (is_pair(code) && (is_pair(code.car) || is_nil(code.car))) {
          if (ellipsis) {
            if (bindings["..."].symbols[name]) {
              let node = bindings["..."].symbols[name];
              node = is_nil(node)
                ? new APair(CONSTANT_CTX, nil, new APair(CONSTANT_CTX, code, nil))
                : concatPair(CONSTANT_CTX, node, new APair(CONSTANT_CTX, code, nil));
              bindings["..."].symbols[name] = node;
            } else {
              bindings["..."].symbols[name] = new APair(CONSTANT_CTX, code, nil);
            }
          } else {
            bindings["..."].symbols[name] = new APair(CONSTANT_CTX, code, nil);
          }
        } else {
          if (is_pair(code)) {
            // cons (a . b) => (var ... . x)
            if (!is_pair(code.cdr) && !is_nil(code.cdr)) {
              if (is_nil(pattern.cdr.cdr)) {
                return false;
              } else if (!bindings["..."].symbols[name]) {
                bindings["..."].symbols[name] = new APair(CONSTANT_CTX, code.car, nil);
                return traverse(pattern.cdr.cdr, code.cdr, state);
              }
            }
            // code as improper list
            const last_pair = code.last_pair()!;
            if (!is_nil(last_pair.cdr)) {
              if (is_nil(pattern.cdr.cdr)) {
                // case (a ...) for (a b . x)
                return false;
              } else {
                // case (a ... . b) for (a b . x)
                const copy = code.clone();
                copy.last_pair()!.cdr = nil;
                bindings["..."].symbols[name] = copy;
                return traverse(pattern.cdr.cdr, last_pair.cdr, state);
              }
            }
            pattern_names.push(name);
            if (bindings["..."].symbols[name]) {
              const node = bindings["..."].symbols[name];
              bindings["..."].symbols[name] = concatPair(CONSTANT_CTX, node, new APair(CONSTANT_CTX, code, nil));
            } else {
              bindings["..."].symbols[name] = new APair(CONSTANT_CTX, code, nil);
            }
          } else if (
            pattern.car instanceof ASymbol &&
            is_pair(pattern.cdr) &&
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
      } else if (is_pair(pattern.car)) {
        var names = [...pattern_names];
        if (is_nil(code)) {
          bindings["..."].lists.push(nil);
          return true;
        }
        let node = code;
        const new_state = { ...state, pattern_names: names, ellipsis: true };
        while (is_pair(node)) {
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
        while (is_pair(node)) {
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
        bindings["..."].symbols[name] ??= [];
        bindings["..."].symbols[name].push(code);
      } else {
        bindings.symbols[name] = code;
      }
      return true;
    }
    if (is_pair(pattern) && is_pair(code)) {
      const rest_pattern = pattern.car instanceof ASymbol && pattern.cdr instanceof ASymbol;
      if (trailing && rest_pattern) {
        // handle (x ... y . z)
        if (!is_nil(code.cdr)) {
          return false;
        }
        const car = (pattern.car as ASymbol).valueOf();
        const cdr = (pattern.cdr as ASymbol).valueOf();
        bindings.symbols[car] = code.car;
        bindings.symbols[cdr] = nil;
        return true;
        //return is_pair(code.cdr) && code.cdr.length() > 1;
      }
      if (is_nil(code.cdr)) {
        // last item in in call using in recursive calls on
        // last element of the list
        // case of pattern (p . rest) and code (0)
        if (rest_pattern) {
          // fix for SRFI-26 in recursive call of (b) ==> (<> . x)
          // where <> is symbol
          if (!traverse(pattern.car, code.car, state)) {
            return false;
          }
          let name = (pattern.cdr as SchemeValue).valueOf();
          if (!(name in bindings.symbols)) {
            bindings.symbols[name] = nil;
          }
          name = (pattern.car as SchemeValue).valueOf();
          if (!(name in bindings.symbols)) {
            bindings.symbols[name] = code.car;
          }
          return true;
        }
      }
      // case (x y) ===> (var0 var1 ... warn) where var1 match nil
      // trailing: true start processing of (var ... x . y)
      if (
        is_pair(pattern.cdr) &&
        is_pair(pattern.cdr.cdr) &&
        pattern.cdr.car instanceof ASymbol &&
        ASymbol.is(pattern.cdr.cdr.car, ellipsis_symbol) &&
        is_pair(pattern.cdr.cdr.cdr) &&
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
    } else if (is_nil(pattern) && (is_nil(code) || code === undefined)) {
      // undefined is case when you don't have body ...
      // and you do recursive call
      return true;
    } else {
      // pattern (...)
      invariant(
        !is_pair(pattern.car) || !ASymbol.is(pattern.car.car, ellipsis_symbol),
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
// :: This function is called after syntax-rules macro is evaluated
// :: Restore hygiene-renamed gensyms to their literal symbols, but ONLY in DATA
// :: positions — under quote / quasiquote, EXCLUDING unquote(-splicing) holes (which
// :: are code). A template identifier under quote is DATA, not a reference, so hygiene
// :: must not rename it (standard expander behaviour). The renamer over-renames every
// :: identifier; this single pass un-renames the data positions of the transcribed
// :: FORM, so quote yields the literal symbol with NO post-eval fixup.
// ::
// :: Why on the form, not the result: the old clear_gensyms ran on the evaluated RESULT.
// :: Under the form-returning / tail-proper evaluator a result-side fixup must ride as an
// :: onResolve, which the trampoline COMPOSES through a tail chain -> O(depth) for a deep
// :: macro tail loop. Restoring the form once per expansion is O(form) and never composes,
// :: so a macro in tail position keeps O(1) TCO.
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
    if (is_pair(n)) {
      const head = n.car;
      let childData = data;
      if (head instanceof ASymbol) {
        const lit = head.literal();
        if (lit === "quote" || lit === "quasiquote") childData = true;
        else if (lit === "unquote" || lit === "unquote-splicing") childData = false;
      }
      // head resolves in the CURRENT context (it is the operator); operands take childData.
      return new APair(CONSTANT_CTX, walk(head, data), walk(n.cdr, childData));
    }
    return n;
  }
  return walk(node, false);
}

// ----------------------------------------------------------------------
export function transform_syntax(options: SchemeValue = {}) {
  // `scope` is now the def-time syntax-child RESOLVER (`defResolver.child("syntax")`); the
  // engine consults its refFrame/lookupSettled/define instead of raw env .ref/.get/.set (P3 3b.2).
  const { bindings, expr, scope: defChild, symbols, names, ellipsis: ellipsis_symbol } = options;
  const gensyms = {};

  function valid_symbol(symbol) {
    if (symbol instanceof ASymbol) {
      return true;
    }
    return ["string", "symbol"].includes(typeof symbol);
  }

  function transform(symbol) {
    invariant(valid_symbol(symbol), `syntax: internal error, need symbol got ${type(symbol)}`);
    const name = symbol.valueOf();
    invariant(name !== ellipsis_symbol, "syntax: internal error, ellipsis not transformed");
    // symbols are gensyms from nested syntax-rules
    const n_type = typeof name;
    if (["string", "symbol"].includes(n_type)) {
      if (name in bindings.symbols) {
        return bindings.symbols[name];
      } else if (n_type === "string" && /\./.test(name)) {
        // calling method on pattern symbol #83
        const parts = name.split(".");
        const first = parts[0];
        if (first in bindings.symbols) {
          return APair.fromArray(CONSTANT_CTX, [
            new ASymbol(CONSTANT_CTX, "."),
            bindings.symbols[first],
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

  function rename(name, symbol) {
    if (!gensyms[name]) {
      // Hygiene identity: does `name` resolve to a frame? refFrame-truthiness ≡ the old
      // scope.ref chain-walk (own bindings, no resolvers/synth, scope-then-capabilities).
      const found = defChild.refFrame(name);
      // nested syntax-rules needs original symbol to get renamed again
      if (typeof name === "symbol" && !found) {
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
    bindings: SchemeValue,
    state: { nested: boolean },
    next: (name: SchemeValue, value: SchemeValue) => void = () => {},
  ): SchemeValue {
    const { nested } = state;
    if (Array.isArray(expr) && expr.length === 0) {
      return expr;
    }
    if (expr instanceof ASymbol) {
      const name = expr.valueOf();
      if (is_gensym(expr) && !bindings[name]) {
        // name = expr.literal();
      }
      if (bindings[name]) {
        if (is_pair(bindings[name])) {
          const { car, cdr } = bindings[name];
          if (nested) {
            if (is_pair(car)) {
              const { car: caar, cdr: cadr } = car;
              if (!is_nil(cadr)) {
                next(name, new APair(CONSTANT_CTX, cadr, nil));
              }
              return caar;
            }
            return car;
          }
          if (!is_nil(cdr)) {
            next(name, cdr);
          }
          return car;
        } else if (Array.isArray(bindings[name])) {
          next(name, bindings[name].slice(1));
          return bindings[name][0];
        }
      }
      return transform(expr);
    }
    const is_array = Array.isArray(expr);
    if (is_pair(expr) || is_array) {
      const exprAny = expr as SchemeValue;
      const first = is_array ? expr[0] : exprAny.car;
      const second = is_array ? expr[1] : is_pair(exprAny.cdr) && exprAny.cdr.car;
      if (first instanceof ASymbol && ASymbol.is(second, ellipsis_symbol)) {
        const rest = is_array ? expr.slice(2) : exprAny.cdr.cdr;
        const name = first.valueOf();
        const item = bindings[name];
        if (item === null) {
          return;
        } else if (name in bindings) {
          if (is_pair(item)) {
            const { car, cdr } = item;
            const rest_expr = is_array ? expr.slice(2) : exprAny.cdr.cdr;
            if (nested) {
              if (!is_nil(cdr)) {
                next(name, cdr);
              }
              if ((is_array && rest_expr.length > 0) || (!is_nil(rest_expr) && !is_array)) {
                const rest = transform_ellipsis_expr(rest_expr, bindings, state, next);
                // Dispatch on the runtime shape of `car`, not the template's
                // shape (`is_array` is about `expr`). A JS-array `car` concats
                // with Array.prototype.concat; a pair `car` concats with
                // concatPair. Discriminating on `car` keeps a pair from ever
                // reaching `.concat` (which APair does not have → throw).
                if (Array.isArray(car)) {
                  return car.concat(rest);
                } else if (is_pair(car)) {
                  return concatPair(CONSTANT_CTX, car, rest);
                } else {
                }
              }
              return car;
            } else if (is_pair(car)) {
              if (!is_nil(car.cdr)) {
                next(name, new APair(CONSTANT_CTX, car.cdr, cdr));
              }
              // wrap with EnvLookup to handle undefined
              return new EnvLookup(car.car);
            } else if (is_nil(cdr)) {
              return car;
            } else {
              const last_pair = (expr as APair).last_pair()!;
              if (last_pair.cdr instanceof ASymbol) {
                next(name, item.last_pair());
                return car;
              }
            }
          } else if (Array.isArray(item)) {
            if (nested) {
              next(name, item.slice(1));
              return APair.fromArray(CONSTANT_CTX, item);
            } else {
              const rest = item.slice(1);
              if (rest.length > 0) {
                next(name, rest);
              }
              return item[0];
            }
          } else {
            return item;
          }
        }
      }
      const rest_expr = is_array ? expr.slice(1) : expr.cdr;
      const head = transform_ellipsis_expr(first, bindings, state, next);
      const rest = transform_ellipsis_expr(rest_expr, bindings, state, next);
      if (is_array) {
        return [head, ...rest];
      }
      return new APair(CONSTANT_CTX, head, rest);
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
        return is_pair(x) || is_nil(x) || (Array.isArray(x) && x.length > 0);
      })
    );
  }

  function get_names(object) {
    return [...Object.keys(object), ...Object.getOwnPropertySymbols(object)];
  }

  function traverse(expr: SchemeValue, { disabled }: SchemeValue = {}) {
    const is_array = Array.isArray(expr);
    if (is_array && expr.length === 0) {
      return expr;
    }
    if (is_pair(expr) || is_array) {
      const exprVal = expr as SchemeValue;
      const first = is_array ? expr[0] : exprVal.car;
      let second, rest_second;
      if (is_array) {
        second = expr[1];
        rest_second = expr.slice(2);
      } else if (is_pair(exprVal.cdr)) {
        second = exprVal.cdr.car;
        rest_second = exprVal.cdr.cdr;
      }
      // escape ellispsis from R7RS e.g. (... ...): the escape form is
      // `(... <template>)`, so `first.cdr` must itself be a pair carrying
      // <template> in its car. Guard it before reading `.car` — a bare
      // `(...)` would leave `first.cdr` as nil, whose `.car` is undefined.
      if (!disabled && is_pair(first) && ASymbol.is(first.car, ellipsis_symbol) && is_pair(first.cdr)) {
        return new APair(CONSTANT_CTX, first.cdr.car, traverse(exprVal.cdr));
      }
      if (second && ASymbol.is(second, ellipsis_symbol) && !disabled) {
        const symbols = bindings["..."].symbols;
        // skip expand list of pattern was (x y ... z)
        // and code was (x z) so y == null
        const values = Object.values(symbols);
        if (values.length > 0 && values.every((x) => x === null)) {
          return traverse(rest_second, { disabled });
        }
        const keys = get_names(symbols);
        // case of list as first argument ((x . y) ...) or (x ... ...)
        // we need to recursively process the list
        // if we have pattern (_ (x y z ...) ...) and code (foo (1 2) (1 2))
        // x an y will be arrays of [1 1] and [2 2] and z will be array
        // of rest, x will also have it's own mapping to 1 and y to 2
        // in case of usage outside of ellipsis list e.g.: (x y)
        const is_spread = first instanceof ASymbol && ASymbol.is(rest_second.car, ellipsis_symbol);
        if (is_pair(first) || is_spread) {
          // lists is free ellipsis on pairs ((???) ...)
          // TODO: will this work in every case? Do we need to handle
          // nesting here?
          if (is_nil(bindings["..."].lists[0])) {
            if (!is_spread) {
              return traverse(rest_second, { disabled });
            }
            return nil;
          }
          let new_expr = first;
          if (is_spread) {
            // TODO: array
            new_expr = new APair(CONSTANT_CTX, first, new APair(CONSTANT_CTX, second, nil));
          }
          let result;
          if (keys.length > 0) {
            let bind = { ...symbols };
            result = is_array ? [] : nil;
            while (true) {
              if (!have_binding(bind)) {
                break;
              }
              const new_bind = {};
              const next = (key, value) => {
                // ellipsis decide if what should be the next value
                // there are two cases ((a . b) ...) and (a ...)
                new_bind[key] = value;
              };
              let car = transform_ellipsis_expr(new_expr, bind, { nested: true }, next);
              // undefined can be null caused by null binding
              // on empty ellipsis
              if (car !== undefined) {
                if (car instanceof EnvLookup) {
                  car = car.valueOf();
                }
                if (is_spread) {
                  if (is_array) {
                    if (Array.isArray(car)) {
                      result.push(...car);
                    } else {
                    }
                  } else {
                    result = is_nil(result) ? car : concatPair(CONSTANT_CTX, result, car);
                  }
                } else if (is_array) {
                  result.push(car);
                } else {
                  result = new APair(CONSTANT_CTX, car, result);
                }
              }
              bind = new_bind;
            }
            if (!is_nil(result) && !is_spread && !is_array) {
              result = APair.fromArray(CONSTANT_CTX, result.to_array(false).reverse(), false);
            }
            // case of (list) ... (rest code)
            if (is_array) {
              if (rest_second) {
                const rest = traverse(rest_second, { disabled });
                return result.concat(rest);
              }
              return result;
            }
            if (!is_nil(exprVal.cdr.cdr) && !ASymbol.is(exprVal.cdr.cdr.car, ellipsis_symbol)) {
              const rest = traverse(exprVal.cdr.cdr, { disabled });
              return concatPair(CONSTANT_CTX, result, rest);
            }
            return result;
          } else {
            let car = transform_ellipsis_expr(first, symbols, {
              nested: true,
            });
            if (car) {
              if (car instanceof EnvLookup) {
                car = car.valueOf();
              }
              return new APair(CONSTANT_CTX, car, nil);
            }
            return nil;
          }
        } else if (first instanceof ASymbol) {
          if (ASymbol.is(rest_second.car, ellipsis_symbol)) {
            // case (x ... ...)
          } else {
          }
          // case: (x ...)
          const name = first.__name__;
          let bind = { [name]: symbols[name] };
          const is_null = symbols[name] === null;
          let result: SchemeValue = is_array ? [] : nil;
          while (true) {
            if (!have_binding(bind, true)) {
              break;
            }
            const new_bind = {};
            const next = (key, value) => {
              new_bind[key] = value;
            };
            let value = transform_ellipsis_expr(expr, bind, { nested: false }, next);
            if (value !== undefined) {
              if (value instanceof EnvLookup) {
                value = value.valueOf();
              }
              if (is_array) {
                result.push(value);
              } else {
                result = new APair(CONSTANT_CTX, value, result);
              }
            }
            bind = new_bind;
          }
          if (!is_nil(result) && !is_array) {
            result = APair.fromArray(CONSTANT_CTX, result.to_array(false).reverse(), false);
          }
          // case if (x ... y ...) second spread is not processed
          // and (??? . x) last symbol
          // by ellipsis transformation
          const exprCdr = (expr as SchemeValue).cdr;
          if (is_pair(exprCdr) && (is_pair(exprCdr.cdr) || exprCdr.cdr instanceof ASymbol)) {
            const node = traverse(exprCdr.cdr, { disabled });
            if (is_null) {
              return node;
            }
            if (is_nil(result)) {
              result = node;
            } else {
              result = concatPair(CONSTANT_CTX, result, node);
            }
          }
          return result;
        }
      }
      const head = traverse(first, { disabled });
      let rest;
      let is_syntax;
      if (first instanceof ASymbol) {
        const value = defChild.lookupSettled(first);
        is_syntax = value instanceof Macro && value.__name__ === "syntax-rules";
      }
      const exprAny = expr as SchemeValue;
      if (is_syntax) {
        rest =
          exprAny.cdr.car instanceof ASymbol
            ? new APair(CONSTANT_CTX, 
                traverse(exprAny.cdr.car, { disabled }),
                new APair(CONSTANT_CTX, exprAny.cdr.cdr.car, traverse(exprAny.cdr.cdr.cdr, { disabled })),
              )
            : new APair(CONSTANT_CTX, exprAny.cdr.car, traverse(exprAny.cdr.cdr, { disabled }));
      } else {
        rest = traverse(exprAny.cdr, { disabled });
      }
      return new APair(CONSTANT_CTX, head, rest);
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

// -------------------------------------------------------------------------
export function self_evaluated(obj) {
  const type = typeof obj;
  return (
    ["string", "function"].includes(type) ||
    typeof obj === "symbol" ||
    obj instanceof ASymbol ||
    obj instanceof AString ||
    obj instanceof RegExp ||
    obj instanceof AExact ||
    obj instanceof AInexact
  );
}
