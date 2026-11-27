import { Bot, Pause, Play, RefreshCw, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { RiskModeField } from "@/features/binary/RiskModeField";
import { useFuturesBot, useFuturesBotControl, useFuturesBotRun } from "@/features/futures/hooks";
import type { RiskMode } from "@/services/api";
import { app } from "@/lib/paths";
import { cn, formatDateTime, formatMoney } from "@/lib/utils";

const BOT_MARKETS = ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD"];
const OUTCOME = {
  opened: ["positive", "Opened"], no_trade: ["neutral", "No trade"], holding: ["info", "Holding"], risk_rejected: ["negative", "Risk rejected"], error: ["warning", "Error"],
} as const;
const pct = (v: number | null | undefined) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);

function PauseHelp({ reason, accountId }: { reason: string; accountId: string }) {
  const r = reason.toLowerCase();
  const risk = <Link to={app(`/risk?account=${accountId}`)} className="underline">Risk limits</Link>;
  if (r.includes("daily loss")) return <>The daily loss limit protects the account and resets at 00:00 UTC. You can also change it in {risk}.</>;
  if (r.includes("drawdown")) return <>Review, then reset the drawdown breaker in {risk}.</>;
  if (r.includes("kill switch")) return <>Release the kill switch in {risk}, then resume.</>;
  if (r.includes("edge guard")) return <>Its closed trades were losing money on average. Change its markets or size, then start it again.</>;
  if (r.includes("halted")) return <>An administrator halted all trading.</>;
  return null;
}

/** The automatic futures bot: it asks the AI futures model every 15 minutes and trades only a validated edge, with a stop-loss and a 4-hour exit. */
export function FuturesBotPanel({ accountId, currency }: { accountId: string; currency: string }) {
  const bot = useFuturesBot(accountId);
  const control = useFuturesBotControl();
  const run = useFuturesBotRun();
  const b = bot.data;
  const [markets, setMarkets] = useState<string[]>([]);
  const [marginPct, setMarginPct] = useState("5");
  const [maxLev, setMaxLev] = useState(3);
  const [scan, setScan] = useState(false);
  const [mode, setMode] = useState<RiskMode>("careful");
  useEffect(() => {
    if (!b) return;
    setMarkets(b.symbols); setMarginPct(String(b.margin_pct)); setMaxLev(b.max_leverage); setScan(!!b.scan); setMode(b.risk_mode ?? "careful");
  }, [b?.account_id, b?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!b) return <Card><CardBody>{bot.error ? <ErrorBanner error={bot.error} /> : <Spinner />}</CardBody></Card>;
  const running = b.status === "RUNNING";
  const tone = running ? "positive" : b.status === "PAUSED" ? "warning" : "neutral";
  const net = Number(b.stats.net_pnl);
  const act = (action: "start" | "pause" | "stop") =>
    control.mutate({ account_id: accountId, action, ...(action === "start" ? { symbols: markets, margin_pct: Number(marginPct), max_leverage: maxLev, scan, risk_mode: mode } : {}) });

  return (
    <Card data-testid="futures-bot" data-tour="futures-bot">
      <CardHeader title={<span className="flex items-center gap-2"><Bot className="size-4 text-accent" />AI futures bot</span>}
        description={`Trades automatically, only when the AI futures model has a tested edge after costs. Every trade has a stop-loss and closes after ${b.horizon_hours} hours.`}
        action={<span className="flex gap-1.5">{b.risk_mode === "practice" && <Badge tone="warning" data-testid="futures-bot-practice">Practice · high risk</Badge>}
          {b.scan && <Badge tone="info">Scanning all coins</Badge>}
          <Badge tone={tone} data-testid="futures-bot-status">{running ? "Running" : b.status === "PAUSED" ? "Paused" : "Stopped"}</Badge></span>} />
      <CardBody className="space-y-4">
        {b.status === "PAUSED" && b.paused_reason && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm" role="status">
            <div className="font-medium">Paused: {b.paused_reason}</div>
            <div className="text-muted"><PauseHelp reason={b.paused_reason} accountId={accountId} /></div>
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <div className="space-y-3">
            <fieldset disabled={running} className="space-y-3">
              <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={scan} onChange={(e) => setScan(e.target.checked)} />
                <span><span className="font-medium text-fg">Scan every crypto coin</span>
                  <span className="block text-muted">Asks the model about all coins each cycle and trades wherever its test passes (up to 5 positions at once).</span></span>
              </label>
              <div className="text-xs text-muted">Markets</div>
              <div className={cn("flex flex-wrap gap-2", scan && "pointer-events-none opacity-40")} role="group" aria-label="Bot markets">
                {BOT_MARKETS.map((m) => {
                  const on = markets.includes(m);
                  return (
                    <button key={m} type="button" aria-pressed={on} onClick={() => setMarkets(on ? markets.filter((x) => x !== m) : [...markets, m])}
                      className={cn("rounded-md border px-2.5 py-1 text-xs", on ? "border-accent bg-accent/15 text-fg" : "border-border text-muted hover:text-fg")}>{m}</button>
                  );
                })}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Margin per trade (% of equity)" htmlFor="fbot-margin" hint="Capped at 20%">
                  <Input id="fbot-margin" inputMode="decimal" className="num" value={marginPct} onChange={(e) => setMarginPct(e.target.value)} />
                </Field>
                <Field label="Maximum leverage" htmlFor="fbot-lev" hint="The model may use less">
                  <Select id="fbot-lev" value={maxLev} onChange={(e) => setMaxLev(Number(e.target.value))}>
                    {[1, 2, 3, 4, 5].map((l) => <option key={l} value={l}>{l}x</option>)}
                  </Select>
                </Field>
              </div>
              <RiskModeField value={mode} onChange={setMode}
                practiceNote="Trades the model's direction whenever it is at least 55% sure, even without a proven edge. Margin capped at 2% of equity and leverage at 2x; stop-loss and 4-hour exit as usual." />
            </fieldset>
            <div className="flex flex-wrap gap-2">
              {!running && <Button onClick={() => act("start")} disabled={control.isPending || !markets.length}><Play />{b.status === "PAUSED" ? "Resume bot" : "Start bot"}</Button>}
              {running && <Button variant="secondary" onClick={() => act("pause")} disabled={control.isPending}><Pause />Pause</Button>}
              {b.status !== "STOPPED" && <Button variant="ghost" onClick={() => act("stop")} disabled={control.isPending}><Square />Stop</Button>}
              {running && <Button variant="ghost" onClick={() => run.mutate(accountId)} disabled={run.isPending}><RefreshCw className={cn(run.isPending && "animate-spin")} />Check now</Button>}
            </div>
            {(control.error || run.error) && <ErrorBanner error={control.error ?? run.error} />}
            <dl className="grid grid-cols-3 gap-2 text-xs" data-testid="futures-bot-stats">
              {[["Trades", b.stats.trades], ["Open", b.stats.open], ["Won / lost", `${b.stats.wins} / ${b.stats.losses}`],
                ["Net P&L", formatMoney(net, currency)], ["Avg on margin", pct(b.stats.avg_return_on_margin)], ["Stops / time exits", `${b.stats.stopped} / ${b.stats.timed_out}`]].map(([k, v]) => (
                <div key={String(k)} className="rounded-lg border border-border bg-surface-2 p-2">
                  <dt className="text-subtle">{k}</dt>
                  <dd className={cn("num text-sm", k === "Net P&L" && (net > 0 ? "text-positive" : net < 0 ? "text-negative" : ""))}>{v}</dd>
                </div>
              ))}
            </dl>
            <p className="text-[11px] text-subtle">
              It checks every {Math.round(b.interval_seconds / 60)} minutes{b.last_cycle_at ? `, last at ${formatDateTime(b.last_cycle_at)}` : ""}. It pauses itself if the risk engine stops trading,
              or if its closed trades show it is losing money.
            </p>
          </div>
          <div>
            <div className="mb-2 text-xs text-muted">What it decided, and why</div>
            {b.recent.length === 0 ? <p className="text-xs text-subtle">Nothing yet. Start the bot to see its reasoning for every market.</p> : (
              <ol className="max-h-72 space-y-2 overflow-y-auto pr-1" data-testid="futures-bot-log">
                {b.recent.map((c, i) => (
                  <li key={i} className="rounded-lg border border-border p-2 text-xs">
                    <div className="flex justify-between gap-2 text-subtle"><span>{c.message}</span><span className="shrink-0">{formatDateTime(c.at)}</span></div>
                    {c.results.map((r, j) => (
                      <div key={j} className="mt-1 flex items-start gap-2">
                        <Badge tone={OUTCOME[r.outcome]?.[0] ?? "neutral"}>{OUTCOME[r.outcome]?.[1] ?? r.outcome}</Badge>
                        <span className="whitespace-nowrap font-medium">{r.symbol}</span>
                        <span className="text-muted">{r.outcome === "opened" ? `${r.side} ${r.leverage}x · margin ${formatMoney(Number(r.margin ?? 0), currency)} · stop ${r.stop_price} · ` : ""}{r.detail}</span>
                      </div>
                    ))}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
