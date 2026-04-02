import { Shield } from "lucide-react";

interface LoginPageProps {
  onLogin: () => Promise<void>;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="glass-panel grid max-w-5xl gap-6 overflow-hidden p-6 lg:grid-cols-[1.25fr,0.9fr] lg:p-8">
        <div className="rounded-[28px] border border-white/10 bg-gradient-to-br from-cyan-300/10 via-white/5 to-transparent p-8">
          <div className="inline-flex items-center gap-3 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-4 py-2 text-sm text-cyan-50">
            <Shield className="h-4 w-4" />
            Incident intelligence for modern teams
          </div>
          <h1 className="mt-8 max-w-xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            Replace Sentry without downgrading how your team triages errors.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-slate-300">
            eKeeper gives every project a glass-clear operational cockpit for recurring failures, grouped issues,
            breadcrumb timelines, and enterprise access control.
          </p>
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {[
              ["7 day windows", "Track recurring regressions by project"],
              ["Grouped issues", "Collapse duplicate failures into actionable clusters"],
              ["Project access", "Govern visibility and ownership across teams"],
            ].map(([title, text]) => (
              <div key={title} className="rounded-3xl border border-white/10 bg-slate-950/25 p-4">
                <p className="text-sm font-semibold text-white">{title}</p>
                <p className="mt-2 text-sm text-slate-300">{text}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col justify-between rounded-[28px] border border-white/10 bg-slate-950/20 p-8">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Secure access</p>
            <h2 className="mt-4 text-2xl font-semibold text-white">Google SSO only</h2>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              Sign in with your approved Google Workspace identity to access projects, dashboards, and incident
              workflows.
            </p>
          </div>

          <button className="button-primary mt-10 w-full" onClick={() => void onLogin()}>
            Continue with Google
          </button>
        </div>
      </div>
    </div>
  );
}
