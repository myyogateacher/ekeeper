export interface ParsedUserAgent {
  browser: string | null;
  os: string | null;
  device: string | null;
}

// The Sentry browser SDK (sentry.javascript.react 8.55.2) sends no `contexts.browser`, `contexts.os` or
// `contexts.device`: a stored student-web-app event carried only `contexts.trace` and `contexts.react`,
// with the User-Agent under `request.headers`. So every web event was stored with browser, os and device
// as ''. `normalizeEvent` calls this only for the fields the contexts left empty, so mobile SDKs that do
// send contexts keep winning.
//
// Why a table and not a UA library: no UA library is installed in backend/package.json, and the stored
// value is a coarse label the MCP `browser` filter matches exactly. A name table is enough for that and
// has no release cycle to keep up with. Unknown stays null, never a guess: a wrong label is worse than
// the blank it replaces, because the filter would then silently drop or mis-count events.

// Each browser's User-Agent also carries the tokens of the engines it embeds: Edge carries Chrome/ and
// Safari/, Chrome carries Safari/, and Android in-app WebViews carry Chrome/. First match wins, so the
// rows run most specific first. Reordering these changes labels silently; the table test in
// user-agent.test.ts pins every row.
const BROWSER_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:FBAN|FBAV|FB_IAB)\//, "Facebook"],
  [/\bInstagram\b/, "Instagram"],
  // Kept apart from "Chrome" so scripted and crawler traffic never inflates the real Chrome count.
  [/HeadlessChrome\//, "HeadlessChrome"],
  [/SamsungBrowser\//, "Samsung Internet"],
  // Edg/ is desktop, EdgA/ Android, EdgiOS/ iOS, Edge/ is legacy EdgeHTML.
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\//, "Opera"],
  // FxiOS/ is Firefox on iOS, which also carries Safari/ and no Firefox/ token.
  [/(?:Firefox|FxiOS)\//, "Firefox"],
  // Android adds "; wv)" to the User-Agent of any WebView. It still carries Chrome/ and Version/4.0, so without
  // this row the pages MYT's React Native app opens in a WebView would count as Chrome. It sits below the
  // named in-app browsers (Facebook, Instagram, which are also "; wv)") so they keep their own label, and
  // above Chrome. iOS has no such marker: an iOS WKWebView has no Safari/ token and stays null below.
  [/; wv\)/, "Android WebView"],
  // CriOS/ is Chrome on iOS, which carries Safari/ and no Chrome/ token.
  [/(?:Chrome|CriOS)\//, "Chrome"],
  // Safari proper has Version/<n> directly before Safari/ (iOS slots Mobile/<build> between them); every
  // Chromium or Gecko browser was matched by a row above. An iOS WKWebView with no Safari/ token matches
  // nothing here, so it stays null.
  [/Version\/[\d.]+ (?:Mobile\/\w+ )?Safari\//, "Safari"],
];

// iOS UAs say "like Mac OS X" and Android UAs say "Linux", so those two rows must precede macOS and Linux.
// iPadOS 13+ Safari sends a Macintosh UA by default, so it is reported as macOS, which is what the UA says.
const OS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

function firstMatch(patterns: ReadonlyArray<readonly [RegExp, string]>, userAgent: string): string | null {
  for (const [pattern, label] of patterns) {
    if (pattern.test(userAgent)) {
      return label;
    }
  }
  return null;
}

const NOT_A_MODEL: ReadonlySet<string> = new Set(["K", "Mobile", "Tablet"]);

function deviceFrom(userAgent: string): string | null {
  const apple = userAgent.match(/iPhone|iPad/);
  if (apple) {
    return apple[0];
  }
  // "Android 13; SM-S918B" or "Android 13; SM-G991B Build/TP1A.220624.014; wv": the model is the token after
  // the version, with any " Build/..." suffix removed. Two kinds of token sit in that slot without naming a
  // device: Chrome 110+ on Android sends the literal "K" (User-Agent reduction), and Firefox for Android sends
  // its form factor, "Mobile" or "Tablet". Those are treated as unknown.
  const model = userAgent.match(/Android [\d.]+; ([^;)]+)/)?.[1]?.replace(/\s+Build\/.*$/, "").trim();
  return model && !NOT_A_MODEL.has(model) ? model : null;
}

// Ingest is public to anyone holding a DSN (DSNs ship in the frontend bundles) and the app sets no body cap,
// while normalizeEvent runs on the single Bun event loop inside the buffer flush. The " Build/..." strip in
// deviceFrom backtracks quadratically on a long run of spaces or of " Build/" tokens (measured: 160k
// characters 3.6 s, 320k 14 s), which would stall ingest, the UI and MCP at once. Every pattern above is
// fed through this function, so the bound lives here and not in each regex. The longest real User-Agent in
// user-agent.test.ts is 270 characters; 512 leaves room for in-app WebViews that append tokens, the same
// order of bound as the clampInt caps on MCP arguments in mcp-tools.ts.
const MAX_USER_AGENT_LENGTH = 512;

export function parseUserAgent(userAgent: string): ParsedUserAgent {
  const bounded = userAgent.slice(0, MAX_USER_AGENT_LENGTH);
  return {
    browser: firstMatch(BROWSER_PATTERNS, bounded),
    os: firstMatch(OS_PATTERNS, bounded),
    device: deviceFrom(bounded),
  };
}

// Sentry puts the page request on `request.headers`. The browser SDK writes "User-Agent"; server SDKs send
// lowercase names, so the lookup ignores case. Headers sent as a list of pairs are not the browser SDK's
// shape and read as absent.
export function userAgentOf(request: unknown): string {
  const headers = (request as { headers?: unknown } | null | undefined)?.headers;
  if (!headers || typeof headers !== "object") {
    return "";
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "user-agent" && typeof value === "string") {
      return value;
    }
  }
  return "";
}
