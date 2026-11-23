import { AlertTriangle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { ApiError } from "@/services/api";
import { cn } from "@/lib/utils";

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin text-muted", className)} aria-label="Loading" />;
}

export function ErrorBanner({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const message = error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong";
  const details =
    error instanceof ApiError && Array.isArray(error.details)
      ? (error.details as { msg: string }[]).map((d) => d.msg.replace(/^Value error, /, ""))
      : [];
  return (
    <div role="alert" className={cn("flex gap-2.5 rounded-md border border-negative/40 bg-negative/10 px-3 py-2.5 text-sm text-negative", className)}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div>
        <p>{message}</p>
        {details.map((d) => <p key={d} className="text-xs opacity-80">{d}</p>)}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {icon && <div className="mb-3 text-subtle [&_svg]:size-6">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-1 max-w-sm text-xs text-muted">{children}</div>}
    </div>
  );
}
