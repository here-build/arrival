// Bite cases for the `@` / `@?` / `@keys` accessor family.
// good = type-checks clean; bad = produces a diagnostic (the A4 field-typo bite).
export const cases: { good: string[]; bad: string[] } = {
  good: [
    '__arr["@"]({ name: "a", age: 30 } as const, "name")',
    '__arr["@?"]({ name: "a" } as const, "name")',
    '__arr["@keys"]({ name: "a", age: 30 } as const)',
    'const n: SNum = __arr["@"]({ name: "a", age: 30 } as const, "age")',
  ],
  bad: [
    // mis-keyed field — `badkey` is not a key of the object → 2345
    '__arr["@"]({ name: "a", age: 30 } as const, "badkey")',
    // wrong-typing the precise result — `age` is SNum, not SStr → 2322
    'const s: SStr = __arr["@"]({ name: "a", age: 30 } as const, "age")',
    // @keys takes an object, not a primitive → error
    '__arr["@keys"](42)',
  ],
};
