import { useState } from "react";
import mytMark from "@/assets/myt-mark.svg";

interface LoginPageProps {
  onLogin: () => Promise<void>;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="card flex w-full max-w-sm flex-col gap-5 p-6">
        <div className="flex items-center gap-2.5">
          <img src={mytMark} alt="MyYogaTeacher" className="h-[26px] w-[26px] shrink-0 object-contain" />
          <span className="text-[15px] font-semibold">eKeeper</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <h1 className="page-title">Sign in</h1>
          <p className="text-[13px] text-muted">Use your MyYogaTeacher Google account. Access is limited to the approved domain.</p>
        </div>
        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={pending}
          onClick={() => {
            setPending(true);
            setError(null);
            onLogin().catch((cause: unknown) => {
              setPending(false);
              setError(cause instanceof Error ? cause.message : "Could not start sign-in. Try again.");
            });
          }}
        >
          {pending ? "Opening Google" : "Continue with Google"}
        </button>
        {error ? (
          <p role="alert" className="text-[13px] text-fatal">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
}
