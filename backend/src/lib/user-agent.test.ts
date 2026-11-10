import { describe, expect, test } from "bun:test";
import { parseUserAgent, userAgentOf } from "./user-agent";

// Strings are real-format User-Agents. Row order mirrors BROWSER_PATTERNS, because the invariant under test
// is that an embedding browser (Edge, Samsung, an in-app WebView) is never reported as the engine it carries.
const cases: Array<[label: string, ua: string, expected: { browser: string | null; os: string | null; device: string | null }]> = [
  ["Facebook in-app on iOS, not Safari", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E219 [FBAN/FBIOS;FBAV/450.0.0.38.108;FBBV/565017714;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.4;FBLC/en_US;FBOP/5]", { browser: "Facebook", os: "iOS", device: "iPhone" }],
  ["Facebook in-app on Android, not Chrome", "Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.144 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.38.108;]", { browser: "Facebook", os: "Android", device: "SM-G991B" }],
  ["Instagram in-app on iOS", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E219 Instagram 330.0.0.20.113 (iPhone14,5; iOS 17_4; en_US; en-US; scale=3.00; 1170x2532; 569428370)", { browser: "Instagram", os: "iOS", device: "iPhone" }],
  ["Instagram in-app on Android, not Chrome", "Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 Instagram 330.0.0.37.104 Android (33/13; 480dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 569428370)", { browser: "Instagram", os: "Android", device: "SM-G991B" }],
  ["HeadlessChrome, not Chrome", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/124.0.0.0 Safari/537.36", { browser: "HeadlessChrome", os: "Linux", device: null }],
  ["Samsung Internet, not Chrome", "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36", { browser: "Samsung Internet", os: "Android", device: "SM-S918B" }],
  ["Edge on Windows, not Chrome", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0", { browser: "Edge", os: "Windows", device: null }],
  ["Edge on Android, reduced model K is unknown", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 EdgA/124.0.0.0", { browser: "Edge", os: "Android", device: null }],
  ["Edge on iOS, not Safari", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/124.0.2478.50 Mobile/15E148 Safari/605.1.15", { browser: "Edge", os: "iOS", device: "iPhone" }],
  ["Opera, not Chrome", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0", { browser: "Opera", os: "Windows", device: null }],
  ["Firefox on Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0", { browser: "Firefox", os: "Windows", device: null }],
  ["Firefox on Linux", "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0", { browser: "Firefox", os: "Linux", device: null }],
  ["Firefox on Android puts Mobile where a model would be, which is not a device", "Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0", { browser: "Firefox", os: "Android", device: null }],
  ["Firefox on an Android tablet puts Tablet there, which is not a device", "Mozilla/5.0 (Android 14; Tablet; rv:125.0) Gecko/125.0 Firefox/125.0", { browser: "Firefox", os: "Android", device: null }],
  ["Firefox on iOS (FxiOS), not Safari", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/125.0 Mobile/15E148 Safari/605.1.15", { browser: "Firefox", os: "iOS", device: "iPhone" }],
  ["Android WebView (the wv marker), not Chrome", "Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.144 Mobile Safari/537.36", { browser: "Android WebView", os: "Android", device: "SM-G991B" }],
  ["Android WebView with the reduced model K", "Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36", { browser: "Android WebView", os: "Android", device: null }],
  ["Chrome on iOS (CriOS), not Safari", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1", { browser: "Chrome", os: "iOS", device: "iPhone" }],
  ["Chrome 149 on Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36", { browser: "Chrome", os: "Windows", device: null }],
  ["Chrome 153 on macOS, as stored for a student-web-app event", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36", { browser: "Chrome", os: "macOS", device: null }],
  ["Chrome on Android with a real model", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36", { browser: "Chrome", os: "Android", device: "Pixel 8" }],
  ["Safari on macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15", { browser: "Safari", os: "macOS", device: null }],
  ["Safari on iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", { browser: "Safari", os: "iOS", device: "iPhone" }],
  ["Safari on iPad", "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1", { browser: "Safari", os: "iOS", device: "iPad" }],
  ["iOS WKWebView with no Safari token stays unknown", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", { browser: null, os: "iOS", device: "iPhone" }],
  ["curl is not a browser", "curl/8.4.0", { browser: null, os: null, device: null }],
  ["empty string", "", { browser: null, os: null, device: null }],
];

describe("parseUserAgent", () => {
  test.each(cases)("an embedding or unknown browser is never labelled as its engine or guessed: %s", (_label, ua, expected) => {
    expect(parseUserAgent(ua)).toEqual(expected);
  });
});

// Ingest is public to anyone holding a DSN and runs on the single event loop, so the invariant is a bound on
// work per event, whatever the header holds. Before the cap, the first input took 3.6 s at 160k characters and
// 14 s at 320k (quadratic backtracking in the Build/ strip), stalling ingest, the UI and MCP.
describe("parseUserAgent work bound", () => {
  const adversarial: Array<[label: string, ua: string]> = [
    ["a long run of spaces after the Android model", "Android 1; x" + " ".repeat(320_000) + "x"],
    ["a long run of Build/ tokens ending in a newline", "Android 1; x" + " Build/".repeat(45_000) + "\nx"],
  ];

  test.each(adversarial)("a 320k character header with %s parses in under 50 ms", (_label, ua) => {
    const started = performance.now();
    parseUserAgent(ua);
    expect(performance.now() - started).toBeLessThan(50);
  });

  test("the longest real User-Agent in the table is well inside the cap, so the cap never changes a real label", () => {
    const longest = cases.reduce((a, b) => (b[1].length > a[1].length ? b : a));
    expect(longest[1].length).toBeLessThan(512);
    expect(parseUserAgent(longest[1])).toEqual(longest[2]);
  });
});

describe("userAgentOf", () => {
  test("reads the browser SDK's User-Agent header", () => {
    expect(userAgentOf({ headers: { "User-Agent": "UA-1" } })).toBe("UA-1");
  });

  test("reads a lowercase header name sent by server SDKs", () => {
    expect(userAgentOf({ headers: { "user-agent": "UA-2" } })).toBe("UA-2");
  });

  test.each([
    ["no request", undefined],
    ["null request", null],
    ["no headers", { url: "https://example.com" }],
    ["headers as a list of pairs", { headers: [["User-Agent", "UA-3"]] }],
    ["non-string header value", { headers: { "User-Agent": 42 } }],
  ])("returns an empty string rather than throwing: %s", (_label, request) => {
    expect(userAgentOf(request)).toBe("");
  });
});
