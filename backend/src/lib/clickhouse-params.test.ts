import { describe, expect, test } from "bun:test";
import { MAX_QUERY_PARAM_BYTES, pairsParamBytes } from "./clickhouse-params";

describe("pairsParamBytes", () => {
  const pairs = (count: number, first: number, second: number) => Array.from({ length: count }, (_, i): [string, string] => [`p${i}`.padEnd(first, "x"), `g${i}`.padEnd(second, "y")]);

  test("plain ids cost one byte a character; each pair adds 24 bytes of brackets, quotes and commas, the array 6", () => {
    // [('ab','cd')] encodes the two brackets, the parentheses, the four quotes and the comma as three bytes each.
    expect(pairsParamBytes([["ab", "cd"]])).toBe(4 + 27);
    expect(pairsParamBytes([["ab", "cd"], ["ef", "gh"]])).toBe(8 + 27 + 24);
    expect(pairsParamBytes([])).toBe(6);
  });

  test("500 pairs of 40 and 32 character ids are about 48 KB, 40 and 150 about 107 KB: both under the budget, as the engine accepted them", () => {
    expect(pairsParamBytes(pairs(500, 40, 32))).toBeLessThan(50_000);
    expect(pairsParamBytes(pairs(500, 40, 150))).toBeGreaterThan(100_000);
    expect(pairsParamBytes(pairs(500, 40, 150))).toBeLessThan(110_000);
  });

  test("500 pairs of 40 and 200 characters are over the engine's 131072 bytes and over the budget", () => {
    const bytes = pairsParamBytes(pairs(500, 40, 200));

    expect(bytes).toBeGreaterThan(131_072);
    expect(bytes).toBeGreaterThan(MAX_QUERY_PARAM_BYTES);
  });

  test("a space is one byte and a colon three, the way URLSearchParams writes them", () => {
    const base = pairsParamBytes([["a", "b"]]);

    expect(pairsParamBytes([["a", "b c"]]) - base).toBe(2);
    expect(pairsParamBytes([["a", "b:c"]]) - base).toBe(4);
  });

  test("a quote or backslash is escaped by the client before it is encoded, so it costs six bytes; a newline becomes \\n, four", () => {
    const base = pairsParamBytes([["a", "b"]]);

    expect(pairsParamBytes([["a", "b'"]]) - base).toBe(6);
    expect(pairsParamBytes([["a", "b\\"]]) - base).toBe(6);
    expect(pairsParamBytes([["a", "b\n"]]) - base).toBe(4);
  });

  test("a non ASCII character costs three bytes for each UTF-8 byte", () => {
    const base = pairsParamBytes([["a", "b"]]);

    expect(pairsParamBytes([["a", "b\u00e9"]]) - base).toBe(6);
    expect(pairsParamBytes([["a", "b\u4e2d"]]) - base).toBe(9);
  });
});
