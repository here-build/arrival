/**
 * SRFI-13 optional `[start end]` bounds on `string-index` and `string-contains`.
 *
 * Indices are code points and the reported index is ABSOLUTE (into the searched string),
 * never relative to `start`. Out-of-range or inverted bounds are a door, not a clamp.
 * `string-contains` takes SRFI-13's full `[start1 end1 start2 end2]`.
 */
import { describe, it, expect } from "vitest";
import { exec } from "../../../index.js";

const one = async (src: string) => (await exec(src))[0];

describe("string-index — [start end]", () => {
  it.each([
    { name: "start skips an earlier match; index is absolute", src: '(string-index "abcdefd" #\\d 4)', value: 6 },
    { name: "start at the match itself", src: '(string-index "abcdefd" #\\d 3)', value: 3 },
    { name: "end is exclusive", src: '(string-index "abcdefd" #\\d 0 3)', value: false },
    { name: "end just past the match", src: '(string-index "abcdefd" #\\d 0 4)', value: 3 },
    { name: "window with no match", src: '(string-index "abcdefd" #\\d 4 6)', value: false },
    { name: "empty window at length", src: '(string-index "abc" #\\c 3)', value: false },
    { name: "empty window in the middle", src: '(string-index "abc" #\\b 1 1)', value: false },
    { name: "predicate criterion honours the window", src: '(string-index "ab12cd34" char-numeric? 4)', value: 6 },
    { name: "no bounds still scans everything", src: '(string-index "abcdefd" #\\d)', value: 3 },
    { name: "astral characters count once", src: '(string-index "a😀b😀c" #\\b 2)', value: 2 },
  ])("$name", async ({ src, value }) => {
    expect(await one(src)).toBe(value);
  });

  it.each([
    { name: "start past length", src: '(string-index "abc" #\\a 4)' },
    { name: "negative start", src: '(string-index "abc" #\\a -1)' },
    { name: "end past length", src: '(string-index "abc" #\\a 0 4)' },
    { name: "start > end", src: '(string-index "abc" #\\a 2 1)' },
  ])("door: $name", async ({ src }) => {
    await expect(exec(src)).rejects.toThrow(/string-index: range \[-?\d+, \d+\) out of range for a string of length 3/);
  });
});

describe("string-contains — [start1 end1 start2 end2]", () => {
  it.each([
    {
      name: "start1 skips the first occurrence; index is absolute",
      src: '(string-contains "abcabc" "abc" 1)',
      value: 3,
    },
    { name: "end1 cuts the search window", src: '(string-contains "abcabc" "abc" 0 5)', value: 0 },
    { name: "end1 excludes a match that would overrun", src: '(string-contains "abcabc" "abc" 1 5)', value: false },
    { name: "start2/end2 pick a substring of the needle", src: '(string-contains "xxbcxx" "abcd" 0 6 1 3)', value: 2 },
    { name: "empty needle is found at start1", src: '(string-contains "abc" "" 2)', value: 2 },
    { name: "empty needle via start2 = end2", src: '(string-contains "abc" "zzz" 1 3 1 1)', value: 1 },
    { name: "needle longer than the window", src: '(string-contains "abcabc" "abcabc" 1)', value: false },
    { name: "no bounds unchanged", src: '(string-contains "abcabc" "cab")', value: 2 },
    { name: "astral characters count once in both strings", src: '(string-contains "a😀b😀c" "😀c" 2)', value: 3 },
  ])("$name", async ({ src, value }) => {
    expect(await one(src)).toBe(value);
  });

  it.each([
    {
      name: "end1 past s1",
      src: '(string-contains "abc" "b" 0 4)',
      re: /\(s1\) out of range for a string of length 3/,
    },
    { name: "start1 > end1", src: '(string-contains "abc" "b" 2 1)', re: /\(s1\) out of range/ },
    {
      name: "end2 past s2",
      src: '(string-contains "abc" "b" 0 3 0 2)',
      re: /\(s2\) out of range for a string of length 1/,
    },
  ])("door: $name", async ({ src, re }) => {
    await expect(exec(src)).rejects.toThrow(re);
  });
});
