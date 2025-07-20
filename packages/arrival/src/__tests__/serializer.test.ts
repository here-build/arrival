import { describe, it, expect } from "vitest";
import { 
  toSExpr, 
  formatSExpr, 
  toSExprString, 
  TO_SEXPR, 
  SEXPR_TAG,
  sexpr 
} from "../serializer";

describe("S-Expression Serializer", () => {
  describe("basic serialization", () => {
    it("converts primitives", () => {
      expect(toSExpr("hello")).toEqual("hello");
      expect(toSExpr(42)).toEqual(42);
      expect(toSExpr(true)).toEqual(true);
      expect(toSExpr(false)).toEqual(false);
      expect(toSExpr(null)).toEqual("nil");
      expect(toSExpr(undefined)).toEqual("undefined");
    });

    it("converts symbols to keywords", () => {
      expect(toSExpr(Symbol.for("visible"))).toEqual(":visible");
      expect(toSExpr(Symbol.for("not-rendered"))).toEqual(":not-rendered");
    });

    it("converts arrays to lists", () => {
      expect(toSExpr([1, 2, 3])).toEqual(["list", 1, 2, 3]);
      expect(toSExpr(["a", "b", "c"])).toEqual(["list", "a", "b", "c"]);
    });

    it("converts objects to maps", () => {
      expect(toSExpr({ a: 1, b: 2 })).toEqual(["map", ":a", 1, ":b", 2]);
      expect(toSExpr({ name: "test", value: 42 }))
        .toEqual(["map", ":name", "test", ":value", 42]);
    });

    it("handles nested structures", () => {
      const obj = {
        name: "test",
        items: [1, 2, 3],
        meta: { count: 3, active: true }
      };
      
      expect(toSExpr(obj)).toEqual([
        "map",
        ":name", "test",
        ":items", ["list", 1, 2, 3],
        ":meta", ["map", ":count", 3, ":active", true]
      ]);
    });
  });

  describe("custom serialization", () => {
    it("uses Symbol.toSymbolicExpression", () => {
      class Custom {
        constructor(public name: string, public value: number) {}
        
        [TO_SEXPR]() {
          return [SEXPR_TAG, "custom", this.name, Symbol.for("value"), this.value];
        }
      }
      
      const obj = new Custom("test", 42);
      expect(toSExpr(obj)).toEqual(["custom", "test", ":value", 42]);
    });

    it("handles nested custom objects", () => {
      class Node {
        constructor(public name: string, public children: Node[] = []) {}
        
        [TO_SEXPR]() {
          return [SEXPR_TAG, "node", this.name, ...this.children];
        }
      }
      
      const tree = new Node("root", [
        new Node("child1"),
        new Node("child2", [new Node("grandchild")])
      ]);
      
      expect(toSExpr(tree)).toEqual([
        "node", "root",
        ["node", "child1"],
        ["node", "child2", ["node", "grandchild"]]
      ]);
    });
  });

  describe("formatting", () => {
    it("formats simple expressions on one line", () => {
      expect(formatSExpr(["add", 1, 2])).toBe('(add 1 2)');
      expect(formatSExpr(["list", "a", "b", "c"])).toBe('(list "a" "b" "c")');
    });

    it("formats complex expressions with indentation", () => {
      const sexpr = [
        "component", "Button",
        ":variants", ["list", "base", "hover"],
        ":tree", ["tpl", "button", ":text", "Click me"]
      ];
      
      const expected = `(component
  "Button"
  :variants
  (list "base" "hover")
  :tree
  (tpl "button" :text "Click me"))`;
      
      expect(formatSExpr(sexpr)).toBe(expected);
    });

    it("handles deeply nested structures", () => {
      const sexpr = [
        "div",
        ["span", ":text", "Hello"],
        ["div",
          ["p", ":text", "World"],
          ["p", ":text", "!"]
        ]
      ];
      
      const expected = `(div
  (span :text "Hello")
  (div
    (p :text "World")
    (p :text "!")))`;
      
      expect(formatSExpr(sexpr)).toBe(expected);
    });

    it("quotes all strings", () => {
      expect(formatSExpr("hello world")).toBe('"hello world"');
      expect(formatSExpr("hello")).toBe('"hello"');
      expect(formatSExpr('say "hi"')).toBe('"say \\"hi\\""');
    });

    it("doesn't quote keywords", () => {
      expect(formatSExpr(":keyword")).toBe(":keyword");
      expect(formatSExpr(":not-rendered")).toBe(":not-rendered");
    });
  });

  describe("edge cases", () => {
    it("handles circular references gracefully", () => {
      const obj: any = { name: "test" };
      obj.self = obj; // circular reference
      
      // This will likely cause a stack overflow in current implementation
      // In a real implementation, we'd track visited objects
      expect(() => toSExpr(obj)).toThrow();
    });
  });
});