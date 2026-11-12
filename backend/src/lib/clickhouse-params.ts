// @clickhouse/client sends every query parameter in the request URL, and ClickHouse refuses a parameter whose URL
// encoded value is longer than http_max_field_value_size, 131072 bytes by default: "HTML Form Exception: Field
// value too long" (code 1000), which reaches a route as a 500. Measured on 24.8.14.39 with the harness
// configuration through queryAffectedUsers: 500 pairs of 40 and 150 character ids (about 107,000 encoded bytes)
// ran, 500 pairs of 40 and 200 characters (about 132,000) were refused, and a per query setting does not raise the
// limit. A route that takes a caller sized set checks it here and answers 400 instead.
//
// 100,000 leaves about 30% below the default for a server profile that sets it lower than this repo's compose
// file does. 500 ordinary pairs (a 40 character project id and a 32 character hash group id) are about 48,000.
export const MAX_QUERY_PARAM_BYTES = 100_000;

// What @clickhouse/client's formatQueryParams does to a string inside a tuple (client-common 1.18.2,
// data_formatter/format_query_params.js): tab, newline, carriage return, quote and backslash are escaped, then the
// string is single quoted. Copied here only to size the value, so a drift costs accuracy at the margin, not
// correctness: the margin above is wider than any escape count a real id has.
function quoted(value: string): string {
  return `'${value.replace(/[\t\n\r'\\]/g, (char) => ({ "\t": "\\t", "\n": "\\n", "\r": "\\r", "'": "\\'", "\\": "\\\\" })[char]!)}'`;
}

/**
 * The URL encoded length in bytes of an `Array(Tuple(String, String))` query parameter holding these pairs,
 * counted as URLSearchParams encodes it (the client builds the URL with it): a space is one byte, a letter, digit
 * or `*-._` is one, every other byte of the UTF-8 text is three, so `:`, `(`, `'`, `,` and non ASCII cost more.
 */
export function pairsParamBytes(pairs: ReadonlyArray<readonly [string, string]>): number {
  const literal = `[${pairs.map(([first, second]) => `(${quoted(first)},${quoted(second)})`).join(",")}]`;
  return new URLSearchParams({ p: literal }).toString().length - "p=".length;
}
