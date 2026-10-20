// Leaf module (no class imports): the accessor-key fold shared by every `:key` member term
// — AJSObject, AJSArray, and APair's alist read. Lives apart from the classes so APair can
// use it without an APair → AJSObject → rosetta import cycle.
import type { SchemeValue } from "./types.js";

/** Member-name fold: face-normalized string passes through; a SchemeValue key (keyword
 *  symbol, boxed string) unwraps via valueOf with the `:` accessor sigil stripped.
 *  (ADict's `foldKeyName` is a different, typed fold over DictKey — it does not strip a string's `:`.) */
export function foldMemberName(key: SchemeValue | string): string {
  let name =
    typeof key === "string" ? key : String((key as { valueOf?: () => unknown } | null | undefined)?.valueOf?.() ?? key);
  if (name.startsWith(":")) name = name.slice(1);
  return name;
}
