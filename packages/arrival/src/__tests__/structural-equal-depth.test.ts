/** `equal?` walks nesting with a heap worklist: depth is bounded by memory, not the host stack. */
import { describe, expect, it } from "vitest";
import { exec } from "../eval/generator-exec.js";

const DEPTH = 20_000;

describe("equal? on deeply nested structure", () => {
  it("car-nested lists", async () => {
    const r = await exec(`
      (define (nest n leaf) (let loop ((i 0) (acc leaf)) (if (= i n) acc (loop (+ i 1) (list acc)))))
      (define a (nest ${DEPTH} 1))
      (list (equal? a (nest ${DEPTH} 1)) (equal? a (nest ${DEPTH} 2)))`);
    expect(r.at(-1)).toEqual([true, false]);
  }, 60_000);
  it("cdr-nested lists", async () => {
    const r = await exec(`
      (define (flat n) (let loop ((i 0) (acc '())) (if (= i n) acc (loop (+ i 1) (cons i acc)))))
      (define a (flat ${DEPTH}))
      (list (equal? a (flat ${DEPTH})) (equal? a (flat ${DEPTH - 1})))`);
    expect(r.at(-1)).toEqual([true, false]);
  }, 60_000);
  it("vector-nested", async () => {
    const r = await exec(`
      (define (nest n leaf) (let loop ((i 0) (acc leaf)) (if (= i n) acc (loop (+ i 1) (vector acc)))))
      (define a (nest ${DEPTH} 1))
      (list (equal? a (nest ${DEPTH} 1)) (equal? a (nest ${DEPTH} 2)))`);
    expect(r.at(-1)).toEqual([true, false]);
  }, 60_000);
  it("cycles still terminate (car- and cdr-cyclic)", async () => {
    const r = await exec(
      `(list (equal? '#0=(1 2 . #0#) '#1=(1 2 . #1#)) (equal? '#0=(#0# 1) '#1=(#1# 1)) (equal? '#0=#(1 #0#) '#1=#(1 #1#)) (equal? '#0=(1 . #0#) '#1=(2 . #1#)))`,
    );
    expect(r.at(-1)).toEqual([true, true, true, false]);
  }, 60_000);
});
