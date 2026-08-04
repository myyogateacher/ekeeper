import type { PropsWithChildren, ReactNode } from "react";

export type DataTableHeader = string | { label: string; align?: "left" | "right" };

interface DataTableProps {
  headers: DataTableHeader[];
  children: ReactNode;
}

export function DataTable({ headers, children }: PropsWithChildren<DataTableProps>) {
  return (
    <div className="table-shell">
      <table className="min-w-full divide-y divide-white/10 text-left text-sm">
        <thead className="bg-white/[0.04] text-xs uppercase tracking-[0.22em] text-slate-400">
          <tr>
            {headers.map((header) => {
              const label = typeof header === "string" ? header : header.label;
              const align = typeof header === "string" ? "left" : header.align ?? "left";
              return (
                <th
                  key={label}
                  className={`px-5 py-4 font-medium ${align === "right" ? "text-right" : ""}`}
                >
                  {label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/6">{children}</tbody>
      </table>
    </div>
  );
}
