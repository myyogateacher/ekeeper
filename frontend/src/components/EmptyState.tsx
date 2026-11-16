import type { ReactNode } from "react";

/** The centred message used for every empty, failed and not-found state, so they read as one family. */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 px-6 py-12 text-center">
      <h2 className="m-0 text-base font-semibold">{title}</h2>
      {children ? <div className="max-w-md text-[13px] text-muted">{children}</div> : null}
      {action}
    </div>
  );
}
