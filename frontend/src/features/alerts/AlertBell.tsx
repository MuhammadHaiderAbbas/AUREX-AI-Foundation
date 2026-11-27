import { Bell, BellRing } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn, formatDateTime } from "@/lib/utils";
import { alertText, useAlertNotifications, useAlerts, useCancelAlert, useMarkAlertsSeen } from "./hooks";

/** Header bell: triggered alerts (unread count) and the list of active ones. */
export function AlertBell() {
  const alerts = useAlerts();
  const seen = useMarkAlertsSeen();
  const cancel = useCancelAlert();
  useAlertNotifications(alerts.data);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, []);
  const items = alerts.data ?? [];
  const unread = items.filter((a) => a.status === "TRIGGERED" && !a.seen_at);
  const active = items.filter((a) => a.status === "ACTIVE");
  const recent = items.filter((a) => a.status === "TRIGGERED").slice(0, 8);
  return (
    <div className="relative" ref={ref} data-tour="alerts-bell">
      <button aria-label={unread.length ? `Price alerts, ${unread.length} new` : "Price alerts"} aria-expanded={open} data-testid="alert-bell"
        onClick={() => { setOpen(!open); if (!open && unread.length) seen.mutate(); }}
        className="relative rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-fg">
        {unread.length ? <BellRing className="size-4 text-warning" /> : <Bell className="size-4" />}
        {unread.length > 0 && <span className="num absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-negative text-[10px] font-semibold text-white">{unread.length}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Price alerts" className="absolute right-0 z-50 mt-1.5 w-80 overflow-hidden rounded-xl border border-border bg-surface-2 shadow-2xl shadow-black/50">
          <div className="border-b border-border px-4 py-3 text-sm font-semibold">Price alerts</div>
          <div className="max-h-96 overflow-y-auto">
            {recent.length > 0 && <div className="px-4 pt-3 text-[11px] font-semibold uppercase tracking-wider text-subtle">Triggered</div>}
            {recent.map((a) => (
              <div key={a.id} className={cn("px-4 py-2.5 text-sm", !a.seen_at && "bg-accent/5")} data-testid="alert-triggered">
                <div>{alertText(a)}</div>
                <div className="text-xs text-subtle">{a.triggered_price && <>at {a.triggered_price} · </>}{a.triggered_at && formatDateTime(a.triggered_at)}{a.note && <> · {a.note}</>}</div>
              </div>
            ))}
            <div className="px-4 pt-3 text-[11px] font-semibold uppercase tracking-wider text-subtle">Active ({active.length})</div>
            {active.length === 0 && <p className="px-4 py-3 text-xs text-subtle">No active alerts. Set one from the Trade screen.</p>}
            {active.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                <span>{a.symbol} {a.direction === "ABOVE" ? "≥" : "≤"} <span className="num">{a.price}</span>{a.note && <span className="text-xs text-subtle"> · {a.note}</span>}</span>
                <button className="text-xs text-muted hover:text-negative" onClick={() => cancel.mutate(a.id)} aria-label={`Cancel alert ${a.symbol} ${a.price}`}>Cancel</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
