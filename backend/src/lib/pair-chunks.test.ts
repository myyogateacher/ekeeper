import { describe, expect, test } from "bun:test";
import { MAX_CHUNK_JSON_BYTES, chunkPairs } from "./pair-chunks";

const pair = (first: string, second: string) => [first, second] as const;
const jsonBytes = (chunk: ReadonlyArray<readonly [string, string]>) => Buffer.byteLength(JSON.stringify(chunk));

describe("chunkPairs", () => {
  test("no pairs is no chunks, and a few small pairs are one chunk in their order", () => {
    expect(chunkPairs([])).toEqual([]);
    expect(chunkPairs([pair("a", "1"), pair("b", "2"), pair("c", "3")])).toEqual([[pair("a", "1"), pair("b", "2"), pair("c", "3")]]);
  });

  test("every chunk's JSON is within the limit, nothing is lost or reordered, and the 500 pair worst case is a few chunks", () => {
    const pairs = Array.from({ length: 500 }, (_, index) => pair(`project_${index}`.padEnd(40, "p"), `legacy-${index}`.padEnd(4096, "g")));

    const chunks = chunkPairs(pairs);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(6);
    for (const chunk of chunks) {
      expect(jsonBytes(chunk)).toBeLessThanOrEqual(MAX_CHUNK_JSON_BYTES);
    }
    expect(chunks.flat()).toEqual(pairs);
  });

  test("500 pairs of the ids a real list has are one chunk", () => {
    const pairs = Array.from({ length: 500 }, (_, index) => pair(`project_${index}`.padEnd(40, "p"), `${index}`.padStart(32, "0")));

    expect(chunkPairs(pairs)).toHaveLength(1);
  });

  test("a pair larger than the limit is a chunk of its own, not dropped", () => {
    const big = pair("p", "x".repeat(300));

    expect(chunkPairs([pair("a", "1"), big, pair("b", "2")], 100)).toEqual([[pair("a", "1")], [big], [pair("b", "2")]]);
  });

  test("the limit counts UTF-8 bytes, so non-ASCII ids make more chunks than the same number of ASCII ones", () => {
    const ascii = Array.from({ length: 10 }, () => pair("p", "a".repeat(30)));
    const cjk = Array.from({ length: 10 }, () => pair("p", "中".repeat(30)));

    expect(chunkPairs(cjk, 250).length).toBeGreaterThan(chunkPairs(ascii, 250).length);
  });

  test("a chunk ends exactly at the limit: one more byte starts a new chunk", () => {
    const item = pair("p", "q");
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;

    expect(chunkPairs([item, item, item], size * 3)).toHaveLength(1);
    expect(chunkPairs([item, item, item], size * 3 - 1)).toHaveLength(2);
  });
});
