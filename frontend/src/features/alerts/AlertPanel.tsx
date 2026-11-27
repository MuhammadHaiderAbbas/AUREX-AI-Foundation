import { BellPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/form";
import { useAlerts, useCancelAlert, useCreateAlert } from "./hooks";

/** Trade screen: set an alert on the selected instrument and see its active alerts. */
export function AlertPanel({ symbol, last, decimals }: { symbol: string; last: number | null; decimals: number }) {
  const alerts = useAlerts();
  const create = useCreateAlert();
  const cancel = useCancelAlert();
  const [direction, setDirection] = useState<"ABOVE" | "BELOW">("ABOVE");
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => { setPrice(""); create.reset(); }, [symbol]); // eslint-disable-line react-hooks/exhaustive-deps
  const mine = (alerts.data ?? []).filter((a) => a.symbol === symbol && a.status === "ACTIVE");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (typeof Notification !== "undefined" && Notification.permission === "default") { try { await Notification.requestPermission(); } catch { /* ignore */ } }
    create.mutate({ symbol, direction, price, note: note.trim() || undefined }, { onSuccess: () => { setPrice(""); setNote(""); } });
  }
  return (
    <div className="rounded-xl border border-border/70 bg-surface p-4" data-tour="alert-panel" data-testid="alert-panel">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><BellPlus className="size-4 text-accent" />Price alert</h3>
      <form className="mt-3 space-y-2" onSubmit={submit}>
        <ErrorBanner error={create.error} />
        <div className="grid grid-cols-[110px_1fr] gap-2">
          <Select aria-label="Alert when price" className="h-8 text-xs" value={direction} onChange={(e) => setDirection(e.target.value as "ABOVE" | "BELOW")}>
            <option value="ABOVE">Rises above</option><option value="BELOW">Falls below</option>
          </Select>
          <Input aria-label="Alert price" inputMode="decimal" className="num h-8 text-xs" required placeholder={last != null ? last.toFixed(decimals) : "Price"}
            value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <Input aria-label="Alert note (optional)" className="h-8 text-xs" maxLength={140} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button type="submit" size="sm" variant="secondary" className="w-full" disabled={!price || create.isPending}>Set alert</Button>
        {create.isSuccess && <p className="text-xs text-positive" role="status">Alert set. You'll see it in the bell when it triggers.</p>}
      </form>
      {mine.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-border pt-3 text-xs" data-testid="symbol-alerts">
          {mine.map((a) => (
            <li key={a.id} className="flex items-center justify-between">
              <span>{a.direction === "ABOVE" ? "Above" : "Below"} <span className="num">{a.price}</span></span>
              <button className="text-muted hover:text-negative" onClick={() => cancel.mutate(a.id)}>Cancel</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
