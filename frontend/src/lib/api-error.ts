/**
 * Carries the HTTP status so callers can tell a refusal from an outage: the query client never retries a
 * 4xx, a 401 sends the user to /login, and a 403 on an issue renders "This issue isn't available" instead
 * of a generic failure. Before this, every failure was a plain Error and those cases were indistinguishable.
 */
export class ApiError extends Error {
  // Declared as a field, not a constructor parameter property: node's strip-types mode (the test runner)
  // only erases type syntax and rejects parameter properties, which need a real transform.
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function isApiStatus(error: unknown, ...statuses: number[]): boolean {
  return error instanceof ApiError && statuses.includes(error.status);
}
