/**
 * box()/patch_value doors raw host objects (NoLensError) instead of casting them to
 * SchemeValue; a host promise settling to an object crosses via the membrane (jsToScheme),
 * so a borrowed container yields a membrane-boxed value, never the raw object.
 */
import { describe, expect, it } from "vitest";
import { NoLensError } from "../../../errors.js";
import { AJSObject } from "../../../membrane/AJSObject.js";
import { AValue } from "../AValue.js";
import { AExact } from "../AExact.js";
import { AString } from "../AString.js";
import { box, patch_value } from "../../values-repr.js";

describe("box — scalars lift, AValues pass, raw host values door", () => {
  it("lifts string/number; passes an AValue through", () => {
    expect(box("x")).toBeInstanceOf(AString);
    expect(box(3)).toBeInstanceOf(AExact);
    const a = new AExact(1);
    expect(box(a)).toBe(a);
  });

  it("doors a plain object, array, function, bigint, symbol", () => {
    expect(() => box({ a: 1 })).toThrow(NoLensError);
    expect(() => box([1])).toThrow(NoLensError);
    expect(() => box(() => 1)).toThrow(NoLensError);
    expect(() => patch_value({ a: 1 })).toThrow(NoLensError);
    expect(() => box(1n)).toThrow(/bigint/);
    expect(() => box(Symbol("u"))).toThrow(NoLensError);
  });
});

describe("pending-entry settlement — host promise to an object", () => {
  it("a borrowed container's promise-valued member settles to a membrane-boxed value", async () => {
    const holder = new AJSObject({ p: Promise.resolve({ a: 1 }) });
    const settled = await holder.get("p");
    expect(settled).toBeInstanceOf(AValue);
    expect(settled).toBeInstanceOf(AJSObject);
    expect(settled).not.toBe(await Promise.resolve({ a: 1 }));
    expect(await (settled as AJSObject).get("a")).toBeInstanceOf(AExact);
    // sync after settlement, same box
    expect(holder.get("p")).toBe(settled);
  });
});
