import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Stat({ label, value, sub, icon, tone, className }: {
  label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode;
  tone?: "positive" | "negative" | "muted"; className?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-border bg-surface p-4", className)}>
      <div className="flex items-center justify-between text-xs text-muted">
        <span className="font-medium uppercase tracking-wider">{label}</span>
        {icon && <span className="text-subtle [&_svg]:size-4">{icon}</span>}
      </div>
      <div className={cn("num mt-2 truncate text-lg font-semibold tracking-tight sm:text-xl",
        tone === "positive" && "text-positive", tone === "negative" && "text-negative",
        tone === "muted" && "text-muted")}>
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-subtle">{sub}</div>}
    </div>
  );
}
