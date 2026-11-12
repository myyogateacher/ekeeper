/**
 * One path segment from a value that came from data (a project id, an issue group id, a user id). Ids are not
 * trusted to be tidy: a group id is the event's explicit fingerprint verbatim (backend/src/lib/ingest.ts:158),
 * so it can hold "/", "..", "?" or "#". Interpolated raw, "probe/../<real id>" made a request for a different
 * issue than the row the user clicked. encodeURIComponent keeps every such character inside the segment.
 *
 * "." and ".." are the one thing it cannot protect: URL parsers collapse those segments, and their %2e
 * spellings, before sending, so the request would name the parent resource. They are refused instead.
 */
export function segment(value: string): string {
  if (!isAddressable(value)) {
    throw new RangeError(`"${value}" cannot be carried in a URL path segment`);
  }
  return encodeURIComponent(value);
}

/** False for the two values no path segment can carry, "." and "..". */
export function isAddressable(value: string): boolean {
  return value !== "." && value !== "..";
}

/**
 * Tag for URL templates: every interpolated value is encoded as one path segment, the fixed text is not.
 * path`/api/projects/${projectId}/errors/${groupId}` is the only form api.ts may use for a URL with an id in
 * it (url.test.ts reads api.ts and fails on a raw interpolation). Query strings are not built with it, since
 * it would encode their "?" and "&"; use URLSearchParams for those.
 */
export function path(strings: TemplateStringsArray, ...values: string[]): string {
  return strings.reduce((url, part, index) => url + part + (index < values.length ? segment(values[index]) : ""), "");
}

/**
 * The client route of one issue, /errors/<project>/<group>, or null when an id cannot be put in a path. The
 * list and the similar-issues rail render a row without a link for null rather than throwing, so one event
 * with a fingerprint of ".." cannot take the whole page down.
 */
export function issuePath(projectId: string, groupId: string): string | null {
  return isAddressable(projectId) && isAddressable(groupId) ? path`/errors/${projectId}/${groupId}` : null;
}
