import type { ReactNode } from "react";

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <h2 className="mb-3 text-sm font-medium text-slate-400 uppercase tracking-wide">{title}</h2>
      {children}
    </section>
  );
}
