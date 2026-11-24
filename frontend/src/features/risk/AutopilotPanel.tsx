import { OctagonX, Pause, Play, RefreshCw, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Select } from "@/components/ui/form";
import { useAccounts } from "@/features/accounts/hooks";
import { useMarketOverview } from "@/features/markets/hooks";
import { useAutopilot, useAutopilotCycle, useEmergencyStop, useRiskOverview } from "@/features/risk/hooks";
import { cn, relativeTime } from "@/lib/utils";
import type { AutopilotCycle } from "@/services/api";

const OUTCOME: Record<string, { label: string; tone: "positive" | "negative" | "neutral" | "warning" }> = {
  executed: { label: "Order placed", tone: "positive" }, risk_rejected: { label: "Risk rejected", tone: "negative" },
  no_trade: { label: "No trade", tone: "neutral" }, skipped: { label: "Skipped", tone: "neutral" }, error: { label: "Error", tone: "warning" },
};

/** Autopilot: agents analyse the chosen instruments on a schedule; every proposal goes through the risk gate. */
export function AutopilotPanel({ accountId: fixed }: { accountId?: string }) {
  const accounts = useAccounts();
  const [picked, setPicked] = useState(fixed ?? "");
  useEffect(() => { if (fixed) setPicked(fixed); else if (!picked && accounts.data?.[0]) setPicked(accounts.data[0].id); }, [fixed, picked, accounts.data]);
  const id = picked || undefined;
  const ov = useRiskOverview(id);
  const overview = useMarketOverview();
  const control = useAutopilot(id);
  const cycle = useAutopilotCycle(id);
  const stop = useEmergencyStop(id);
  const [symbols, setSymbols] = useState<string[] | null>(null);
  const [last, setLast] = useState<AutopilotCycle | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [flatten, setFlatten] = useState(false);
  const ap = ov.data?.autopilot;
  const chosen = symbols ?? ap?.symbols ?? [];
  const instruments = Object.values(overview.data?.groups ?? {}).flat().map((g) => g.instrument.symbol);
  const status = ap?.status ?? "STOPPED";
  const blocked = ov.data?.state.blocked_reason;

  const toggle = (s: string) => setSymbols(chosen.includes(s) ? chosen.filter((x) => x !== s) : chosen.length >= 5 ? chosen : [...chosen, s]);

  if (!accounts.data?.length) return null;
  return (
    <Card data-testid="autopilot">
      <CardHeader title="Autopilot" description="Agents trade the paper account on a schedule. Every proposal passes the independent risk gate."
        action={<Badge tone={status === "RUNNING" ? "positive" : status === "PAUSED" ? "warning" : "neutral"}><StatusDot tone={status === "RUNNING" ? "positive" : status === "PAUSED" ? "warning" : "neutral"} />{status.toLowerCase()}</Badge>} />
      <CardBody className="space-y-3">
        <ErrorBanner error={control.error ?? cycle.error ?? stop.error ?? ov.error} />
        {!fixed && (
          <Field label="Paper account" htmlFor="ap-acct">
            <Select id="ap-acct" value={picked} onChange={(e) => { setPicked(e.target.value); setSymbols(null); setLast(null); }}>
              {accounts.data.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.base_currency}</option>)}
            </Select>
          </Field>
        )}
        {blocked && <p className="rounded-md border border-negative/40 bg-negative/10 px-3 py-2 text-xs text-negative">Blocked: {blocked}</p>}
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">Symbols ({chosen.length}/5)</p>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Autopilot symbols">
            {instruments.map((s) => (
              <button key={s} type="button" aria-pressed={chosen.includes(s)} onClick={() => toggle(s)} disabled={status === "RUNNING"}
                className={cn("rounded border px-2 py-0.5 text-[11px] disabled:opacity-60", chosen.includes(s) ? "border-accent/60 bg-accent/10 text-accent" : "border-border text-muted hover:text-fg")}>{s}</button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {status !== "RUNNING" ? (
            <Button size="sm" onClick={() => control.mutate({ action: "start", symbols: chosen })} disabled={control.isPending || !chosen.length || !!blocked}><Play />Start</Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => control.mutate({ action: "pause" })} disabled={control.isPending}><Pause />Pause</Button>
          )}
          {status !== "STOPPED" && <Button size="sm" variant="secondary" onClick={() => control.mutate({ action: "stop" })} disabled={control.isPending}><Square />Stop</Button>}
          <Button size="sm" variant="outline" disabled={status !== "RUNNING" || cycle.isPending}
            onClick={async () => setLast(await cycle.mutateAsync(undefined))}>{cycle.isPending ? <Spinner /> : <RefreshCw />}Run cycle now</Button>
          <Button size="sm" variant="danger" onClick={() => setConfirm(true)}><OctagonX />Emergency stop</Button>
        </div>
        <p className="text-[11px] text-subtle">
          {ap?.last_cycle_at ? `Last cycle ${relativeTime(ap.last_cycle_at)}` : "No cycle yet"} · runs every {Math.round((ap?.interval_seconds ?? 900) / 60)} min while running ·
          entries are market orders with a protective stop-loss and take-profit (one cancels the other).
        </p>
        {last && (
          <ul className="divide-y divide-border/60 rounded-md border border-border text-xs" data-testid="cycle-result">
            {last.skipped && <li className="px-3 py-2 text-negative">Skipped: {last.skipped}</li>}
            {last.results.map((r) => (
              <li key={r.symbol} className="flex items-center gap-2 px-3 py-2">
                <span className="w-20 font-medium">{r.symbol}</span>
                <Badge tone={OUTCOME[r.outcome]?.tone}>{OUTCOME[r.outcome]?.label ?? r.outcome}</Badge>
                <span className="min-w-0 flex-1 truncate text-muted" title={r.detail}>{r.detail}</span>
                {r.order_id && <Link className="text-accent hover:underline" to={`/history?account=${id}&order=${r.order_id}`}>order</Link>}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Emergency stop">
        <div className="space-y-4 text-sm">
          <p>This stops the autopilot, engages the account kill switch and cancels working entry orders. Protective stops stay in place unless you also flatten.</p>
          <label className="flex items-center gap-2"><input type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} />Also sell every open position at market</label>
          <Button variant="danger" className="w-full" disabled={stop.isPending}
            onClick={async () => { await stop.mutateAsync({ flatten }); setConfirm(false); }}>{stop.isPending && <Spinner />}Confirm emergency stop</Button>
        </div>
      </Dialog>
    </Card>
  );
}
