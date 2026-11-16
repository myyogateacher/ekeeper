// ClickHouse folds `JSONExtract(base64Decode('...'), ...)` into a constant, which is what lets `(project_id, group_id)
// IN <it>` use the sort key, only while the result is under about 1 MiB. Measured on 24.8.14.39 with 500 pairs of
// 40 character project ids: 1,025,000 bytes of JSON folded and ran, 1,275,000 failed with "Function 'in' is
// supported only if second argument is constant or table expression". queryAffectedUsers therefore splits a set
// into chunks under half of that and ORs one IN per chunk, which keeps the union exact in one query. Half, not the
// measured edge, because the folded column also holds an offset per string and the engine's own limit is not
// documented here.
export const MAX_CHUNK_JSON_BYTES = 512_000;

/**
 * Splits pairs into runs whose JSON text is at most `maxBytes`, keeping their order. A single pair larger than the
 * limit gets a run of its own: nothing is dropped, and the caller's schema is what bounds one id.
 */
export function chunkPairs(pairs: ReadonlyArray<readonly [string, string]>, maxBytes = MAX_CHUNK_JSON_BYTES): Array<Array<readonly [string, string]>> {
  const chunks: Array<Array<readonly [string, string]>> = [];
  let current: Array<readonly [string, string]> = [];
  let size = 0;
  for (const pair of pairs) {
    // +1 for the comma between array items.
    const pairBytes = Buffer.byteLength(JSON.stringify(pair)) + 1;
    if (current.length > 0 && size + pairBytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(pair);
    size += pairBytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}
