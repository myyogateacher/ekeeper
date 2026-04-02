import type { PropsWithChildren, ReactNode } from "react";

interface DataTableProps {
  headers: string[];
  children: ReactNode;
}

export function DataTable({ headers, children }: PropsWithChildren<DataTableProps>) {
  return (
    <div className="table-shell">
      <table className="min-w-full divide-y divide-white/10 text-left text-sm">
        <thead className="bg-white/[0.04] text-xs uppercase tracking-[0.22em] text-slate-400">
          <tr>
            {headers.map((header) => (
              <th key={header} className="px-5 py-4 font-medium">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/6">{children}</tbody>
      </table>
    </div>
  );
}
