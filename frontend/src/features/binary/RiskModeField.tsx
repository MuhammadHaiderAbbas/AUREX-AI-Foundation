import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RiskMode } from "@/services/api";

/** Careful (proven edge only) or Practice (the model's best guess, small capped stakes). Shared by both bots. */
export function RiskModeField({ value, onChange, practiceNote }: { value: RiskMode; onChange: (v: RiskMode) => void; practiceNote: string }) {
  const opt = (v: RiskMode, title: string, body: string) => (
    <label className={cn("flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-xs", value === v ? (v === "practice" ? "border-warning/60 bg-warning/10" : "border-accent/60 bg-accent/10") : "border-border")}>
      <input type="radio" name="risk-mode" className="mt-0.5 accent-[var(--color-accent)]" checked={value === v} onChange={() => onChange(v)} aria-label={title} />
      <span><span className="font-medium text-fg">{title}</span><span className="block text-muted">{body}</span></span>
    </label>
  );
  return (
    <fieldset className="space-y-2" role="radiogroup" aria-label="Risk mode">
      <legend className="mb-1 text-xs text-muted">Risk mode</legend>
      {opt("careful", "Careful (recommended)", "Trades only when the model has a proven edge on data it had not seen. On most days that means no trade.")}
      {opt("practice", "Practice: high risk", practiceNote)}
      {value === "practice" && (
        <p className="flex gap-1.5 text-[11px] text-warning" role="note"><AlertTriangle className="size-3.5 shrink-0" />
          Practice trades have no proven edge. Expect to lose paper money over time; the loss guards and risk limits still apply.</p>
      )}
    </fieldset>
  );
}
