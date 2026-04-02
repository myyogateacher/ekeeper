export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function randomToken(size = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(size))).toString("hex");
}
