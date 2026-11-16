import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Code, Inbox, LogIn, Users, type LucideIcon } from "lucide-react";
import { toast } from "react-toastify";
import issuesList from "@/assets/landing-issues-list.png";
import mytLogo from "@/assets/myt-logo.svg";
import mytMark from "@/assets/myt-mark.svg";

interface LandingPageProps {
  /** Starts Google sign-in. `returnTo` is the app page to open once the user is signed in. */
  onLogin: (returnTo?: string) => Promise<void>;
}

type SignInButton = "header" | "hero" | "connect";

const features: Array<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: Inbox,
    title: "Triage in one list",
    body: "Saved views for open, untriaged, yours and reopened issues. Filters live in the link, so a shared link opens the same list.",
  },
  {
    icon: Code,
    title: "Stack traces you can read",
    body: "Source maps turn minified frames into our own files and lines, with library frames folded away.",
  },
  {
    icon: Users,
    title: "See who is affected",
    body: "Users affected, events in the last 24 hours and 7 days, and an hourly chart on every issue.",
  },
  {
    icon: Check,
    title: "Owned until closed",
    body: "Assign an owner, close with undo and sync to GitHub issues. A closed issue reopens on its own if the error comes back.",
  },
];

const wrap = "mx-auto w-full max-w-[1180px] px-8 max-[720px]:px-4";
const band = "border-t border-line py-14 max-[720px]:py-10";
const h2 = "mb-2 text-[28px] font-bold leading-9 max-[720px]:text-2xl max-[720px]:leading-8";
const sub = "max-w-[640px] text-muted";
// The utilities layer outranks the `.btn` component layer, so `h-10` here would also beat `.btn`'s own
// `max-[720px]:h-11` and leave a 40px button on a phone. The phone height is restated so it stays 44px.
const btn = "btn h-10 rounded-lg px-4 text-sm max-[720px]:h-11";

/**
 * The public front door at `/`, shown to a signed-out visitor. It is static content that reads nothing from the
 * server, so it renders outside AppShell and ProtectedLayout. It has no theme switch: the page follows the
 * theme saved in eKeeper, else the system setting, which the inline script in index.html applies before paint.
 */
export function LandingPage({ onLogin }: LandingPageProps) {
  // One state for all three sign-in buttons, which sit far apart on the page: while one is starting, every
  // button is disabled, so a second click cannot start a second /auth/google/start, and only the clicked one
  // reads "Opening Google".
  const [starting, setStarting] = useState<SignInButton | null>(null);
  const origin = window.location.origin;

  const signIn = (button: SignInButton, returnTo?: string) => {
    setStarting(button);
    onLogin(returnTo).catch((cause: unknown) => {
      setStarting(null);
      // A toast and not a message under one button: the failing button may be off screen from the other two.
      toast.error(cause instanceof Error ? cause.message : "Could not start sign-in. Try again.");
    });
  };
  const label = (button: SignInButton, text: string) => (starting === button ? "Opening Google" : text);

  return (
    <div className="text-[15px] leading-6">
      <header className="border-b border-line bg-surface">
        {/* The nav hides at 960px, not the mockup's 720px: brand, nav and button need about 841px, so between 721 and
            840 (iPad portrait) the button wrapped to a second row under the nav (QA). The tagline hides at 440px so
            brand and button stay on one row on a phone; py-3 keeps any wrapped row off the header's edges. */}
        <div className={`${wrap} flex min-h-16 flex-wrap items-center gap-6 py-3`}>
          <Link to="/" className="flex items-center gap-2.5">
            <img src={mytMark} alt="MyYogaTeacher" className="h-7 w-7 object-contain" />
            <b className="text-base font-semibold">eKeeper</b>
            <span className="text-xs text-muted max-[440px]:hidden">by MyYogaTeacher</span>
          </Link>
          <nav aria-label="Sections" className="ml-auto flex gap-5 max-[960px]:hidden">
            <a href="#how" className="text-sm font-medium text-muted hover:text-fg">
              How it works
            </a>
            <a href="#connect" className="text-sm font-medium text-muted hover:text-fg">
              Connect an app
            </a>
            <a href="#mcp" className="text-sm font-medium text-muted hover:text-fg">
              Claude and MCP
            </a>
          </nav>
          <button type="button" className={`${btn} btn-primary max-[960px]:ml-auto`} disabled={starting !== null} onClick={() => signIn("header")}>
            {label("header", "Sign in with Google")}
          </button>
        </div>
      </header>

      <main>
        <section aria-label="eKeeper" className="pb-14 pt-[72px] max-[720px]:pb-8 max-[720px]:pt-10">
          <div className={`${wrap} grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] items-center gap-12 max-[960px]:grid-cols-1`}>
            <div>
              <div className="text-[13px] font-semibold tracking-[0.04em] text-accent">MyYogaTeacher engineering</div>
              <h1 className="mb-4 mt-3 text-[44px] font-bold leading-[52px] tracking-[-0.01em] max-[720px]:text-[32px] max-[720px]:leading-10">
                Every error from our apps, grouped, readable and owned.
              </h1>
              <p className="max-w-[520px] text-[17px] leading-7 text-muted max-[720px]:text-base max-[720px]:leading-[26px]">
                eKeeper is MyYogaTeacher's own error tracker. Our web apps send errors to it with the standard Sentry SDK. eKeeper groups them into
                issues, maps stack traces back to our source code and lets the team assign and close them.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <button
                  type="button"
                  className={`${btn} btn-primary max-[720px]:w-full`}
                  disabled={starting !== null}
                  onClick={() => signIn("hero")}
                >
                  <LogIn className="h-4 w-4" aria-hidden />
                  {label("hero", "Sign in with Google")}
                </button>
                <a href="#connect" className={`${btn} max-[720px]:w-full`}>
                  Connect an app
                </a>
              </div>
              <div className="mt-3 text-[13px] text-muted">Sign in with your MyYogaTeacher Google account.</div>
            </div>
            {/* No colour literal outside theme/tokens.css, so the default shadow ramp stands in for the mockup's custom one. */}
            <figure className="overflow-hidden rounded-xl border border-line bg-surface shadow-2xl">
              <div className="flex gap-1.5 border-b border-line px-3 py-2.5" aria-hidden="true">
                <span className="h-2.5 w-2.5 rounded-full border border-line bg-raised" />
                <span className="h-2.5 w-2.5 rounded-full border border-line bg-raised" />
                <span className="h-2.5 w-2.5 rounded-full border border-line bg-raised" />
              </div>
              {/* width and height reserve the 16:10 box before the PNG decodes, so the hero does not jump. */}
              <img
                src={issuesList}
                alt="The eKeeper issues list with filters, counts and owners"
                width={1440}
                height={900}
                className="block h-auto w-full"
              />
            </figure>
          </div>
        </section>

        <section id="how" aria-labelledby="how-h" className={band}>
          <div className={wrap}>
            <h2 id="how-h" className={h2}>
              How it works
            </h2>
            <p className={`${sub} mb-7`}>From the first error to a closed issue, in one place.</p>
            <div className="grid grid-cols-4 gap-4 max-[960px]:grid-cols-2 max-[720px]:grid-cols-1">
              {features.map(({ icon: Icon, title, body }) => (
                <div key={title} className="flex flex-col gap-2 rounded-[10px] border border-line bg-surface p-5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-raised text-accent">
                    <Icon className="h-5 w-5" aria-hidden />
                  </div>
                  <h3 className="mt-1 text-base font-semibold leading-6">{title}</h3>
                  <p className="text-sm leading-[22px] text-muted">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="connect" aria-labelledby="connect-h" className={band}>
          <div className={wrap}>
            <h2 id="connect-h" className={h2}>
              Connect an app
            </h2>
            <p className={`${sub} mb-7`}>
              Any app that uses the Sentry SDK can report to eKeeper. The setup steps, your project's DSN and the source map settings are inside eKeeper
              after you sign in.
            </p>
            {/* Connect an app is a card in Settings, Projects (pages/settings/ProjectsSection.tsx:157), so sign-in returns there through lib/after-login. */}
            <button
              type="button"
              className={btn}
              disabled={starting !== null}
              onClick={() => signIn("connect", "/settings/projects")}
            >
              {label("connect", "Sign in to connect an app")}
            </button>
          </div>
        </section>

        <section id="mcp" aria-labelledby="mcp-h" className={band}>
          <div className={`${wrap} grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-8 max-[720px]:grid-cols-1`}>
            <div>
              <h2 id="mcp-h" className={h2}>
                Ask Claude about errors
              </h2>
              <p className={sub}>
                eKeeper runs an MCP server, so Claude and other MCP clients can look up issues, events and trends with the same access you have.
                Adding it opens a Google sign in.
              </p>
            </div>
            {/* Focusable because the host name can push the command past the box at phone width, and a keyboard user needs to scroll it. */}
            <pre tabIndex={0} className="mono m-0 overflow-x-auto rounded-lg border border-line bg-code p-3 leading-[19px]">
              {`claude mcp add --transport http ekeeper \\\n  ${origin}/mcp`}
            </pre>
          </div>
        </section>
      </main>

      <footer className="border-t border-line pb-10 pt-7">
        <div className={`${wrap} flex flex-wrap items-center gap-x-6 gap-y-4`}>
          <img src={mytLogo} alt="MyYogaTeacher" className="h-5 w-auto" />
          <p className="flex-[1_1_280px] text-[13px] text-muted">eKeeper is an internal tool of MyYogaTeacher engineering.</p>
        </div>
      </footer>
    </div>
  );
}
