import type { ReactNode } from "react";
import { strings } from "../strings";

export type ScopeOption = { id: string; label: string };

/** A labelled choice of shop or category, empty until one is picked (A03, A05). */
export function ScopePicker({ label, value, options, onChange }: { label: string; value: string; options: ScopeOption[]; onChange: (id: string) => void }) {
  return <label className="block">{label}<select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 block h-10 w-full rounded-lg border border-border-strong bg-surface px-3">
    <option value="">{strings.rateCardSelect}</option>{options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
  </select></label>;
}

/** Names which rate-card scope a value came from (A03, A05). */
export function ScopeChip({ children }: { children: ReactNode }) {
  return <span className="inline-flex rounded-full bg-primary-subtle px-2 py-1 text-sm text-on-primary-subtle">{children}</span>;
}
