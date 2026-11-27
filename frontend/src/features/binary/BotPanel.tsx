import { Bot, Pause, Play, RefreshCw, Square } from "lucide-react";
import { app } from "@/lib/paths";
import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { useBinaryBot, useBotControl, useBotRun } from "@/features/binary/hooks";
import { RiskModeField } from "@/features/binary/RiskModeField";
import { cn, formatDateTime, formatMoney, relativeTime } from "@/lib/utils";
import type { BotCycleResult, RiskMode } from "@/services/api";

const BOT_SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD", "EUR/USD", "GBP/USD", "USD/JPY"];
const EXPIRIES: [number, string][] = [[60, "1 minute"], [300, "5 minutes"], [900, "15 minutes"], [3600, "1 hour"]];
const pct = (v: number | null | undefined, dp = 1) => (v == null ? "—" : `${(v * 100).toFixed(dp)}%`);
const OUTCOME = {
  opened: ["positive", "Opened"], no_trade: ["neutral", "Skipped"], waiting: ["info", "Waiting"], risk_rejected: ["negative", "Risk rejected"], error: ["warning", "Error"],
} as const;

function PauseHelp({ reason, accountId }: { reason: string; accountId: string }) {
  const r = reason.toLowerCase();
  const risk = <Link to={app(`/risk?account=${accountId}`)} className="underline">Risk Centre</Link>;
  if (r.includes("daily loss")) return <>The daily loss limit protects the account; it resets at 00:00 UTC, or raise it (up to 5%) in the {risk}.</>;
  if (r.includes("drawdown")) return <>Review, then reset the drawdown breaker in the {risk}.</>;
  if (r.includes("kill switch")) return <>Release the kill switch in the {risk}, then resume.</>;
  if (r.includes("switched off")) return <>Turn binary options back on in the {risk}.</>;
  if (r.includes("edge guard")) return <>It was losing more often than break-even. Change its instruments or expiry, then start it again.</>;
  if (r.includes("halted")) return <>An administrator halted all trading.</>;
  return null;
}

/** The one-button binary bot: start it, and it trades only when its model shows an out-of-sample edge. */
export function BotPanel({ accountId, currency }: { accountId: string; currency: string }) {
  const bot = useBinaryBot(accountId);
  const control = useBotControl();
  const run = useBotRun();
  const b = bot.data;
  const [symbols, setSymbols] = useState<string[]>([]);
  const [expiry, setExpiry] = useState(60);
  const [stake, setStake] = useState("1");
  const [conf, setConf] = useState("0.6");
  const [agree, setAgree] = useState(true);
  const [scan, setScan] = useState(false);
  const [mode, setMode] = useState<RiskMode>("careful");
  useEffect(() => {
    if (!b) return;
    setSymbols(b.symbols); setExpiry(b.expiry_seconds); setStake(String(b.stake_pct)); setConf(String(b.min_confidence)); setAgree(b.require_futures_agreement ?? true); setScan(!!b.scan); setMode(b.risk_mode ?? "careful");
  }, [b?.account_id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!b) return <Card><CardBody className="flex h-32 items-center justify-center"><Spinner /></CardBody></Card>;
  const running = b.status === "RUNNING";
  const start = () => control.mutate({ account_id: accountId, action: "start", symbols, expiry_seconds: expiry, stake_pct: Number(stake), min_confidence: Number(conf), require_futures_agreement: agree, scan, risk_mode: mode });
  const s = b.stats;
  const beating = s.win_rate != null && s.win_rate >= b.break_even_win_rate;
  return (
    <Card data-testid="binary-bot">
      <CardHeader title={<span className="flex items-center gap-2"><Bot className="size-4 text-accent" />AI binary bot</span>}
        description={`One button. It trades only when its model beat the break-even rate on data it had not seen${b.require_futures_agreement ? " and the futures model agrees with the direction" : ""}, and pauses itself when it stops winning.`}
        action={<span className="flex gap-1.5">{b.risk_mode === "practice" && <Badge tone="warning" data-testid="bot-practice">Practice · high risk</Badge>}
          {b.scan && <Badge tone="info">Scanning all coins</Badge>}
          <Badge tone={running ? "positive" : b.status === "PAUSED" ? "warning" : "neutral"} data-testid="bot-status">{b.status}</Badge></span>} />
      <CardBody className="space-y-4">
        <ErrorBanner error={control.error ?? run.error} />
        {b.data_mode !== "coinbase" && b.data_mode !== "live" && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs" role="note" aria-label="Synthetic data warning">
            <b>{b.data_mode === "mixed" ? "Some instruments use simulated prices." : "Simulated prices."}</b> Crypto streams live from Coinbase; forex here is generated
            from smooth cycles, so the bot finds patterns there that real markets do not have. Wins on simulated prices are <b>not</b> evidence
            that it would make money. On real prices most signals fail its edge test and it simply does not trade.
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <>
              <Button variant="secondary" onClick={() => control.mutate({ account_id: accountId, action: "pause" })} disabled={control.isPending}><Pause />Pause</Button>
              <Button variant="danger" onClick={() => control.mutate({ account_id: accountId, action: "stop" })} disabled={control.isPending}><Square />Stop</Button>
              <Button variant="ghost" onClick={() => run.mutate(accountId)} disabled={run.isPending}>{run.isPending ? <Spinner /> : <RefreshCw />}Run a cycle now</Button>
            </>
          ) : (
            <Button size="lg" className="min-w-56" onClick={start} disabled={control.isPending || symbols.length === 0}>
              {control.isPending ? <Spinner className="text-accent-fg" /> : <Play />}{b.status === "PAUSED" ? "Resume AI bot" : "Start AI bot"}
            </Button>
          )}
          <span className="text-xs text-muted">
            {running ? `Checks ${b.symbols.join(", ")} every ${Math.round(b.interval_seconds)}s${b.last_cycle_at ? ` · last ${relativeTime(b.last_cycle_at)}` : ""}`
              : b.paused_reason ? <span className="text-warning" data-testid="bot-paused-reason">Paused: {b.paused_reason}. <PauseHelp reason={b.paused_reason} accountId={accountId} /></span> : "Paper money only"}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="bot-stats">
          <div className="rounded-lg border border-border p-3"><div className="text-[11px] uppercase tracking-wider text-muted">Bot win rate</div>
            <div className={cn("num text-lg font-semibold", s.win_rate == null ? "text-muted" : beating ? "text-positive" : "text-negative")}>{pct(s.win_rate)}</div>
            <div className="text-[11px] text-subtle">break-even {pct(b.break_even_win_rate)}</div></div>
          <div className="rounded-lg border border-border p-3"><div className="text-[11px] uppercase tracking-wider text-muted">Bot net P&L</div>
            <div className={cn("num text-lg font-semibold", Number(s.net_pnl) > 0 ? "text-positive" : Number(s.net_pnl) < 0 ? "text-negative" : "text-muted")}>{formatMoney(s.net_pnl, currency)}</div>
            <div className="text-[11px] text-subtle">{s.won} won · {s.lost} lost · {s.open} open</div></div>
          <div className="rounded-lg border border-border p-3"><div className="text-[11px] uppercase tracking-wider text-muted">Edge guard</div>
            <div className="num text-lg font-semibold">{s.won + s.lost}/{b.guard_min_contracts}</div>
            <div className="text-[11px] text-subtle">pauses below break-even after {b.guard_min_contracts}</div></div>
          <div className="rounded-lg border border-border p-3"><div className="text-[11px] uppercase tracking-wider text-muted">Stake</div>
            <div className="num text-lg font-semibold">{b.stake_pct}%</div>
            <div className="text-[11px] text-subtle">of equity, min {formatMoney(1, currency)}</div></div>
        </div>

        {!running && (
          <details className="rounded-lg border border-border p-3 text-sm">
            <summary className="cursor-pointer text-xs font-medium text-muted">Bot settings</summary>
            <div className="mt-3 space-y-3">
              <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={scan} onChange={(e) => setScan(e.target.checked)} />
                <span><span className="font-medium text-fg">Scan every crypto coin and expiry</span>
                  <span className="block text-muted">Checks all coins at 1, 5, 15 and 60 minutes (1 and 5 in the browser demo) and trades wherever the test passes. More chances, same rules.</span></span>
              </label>
              <div className={cn("flex flex-wrap gap-1.5", scan && "pointer-events-none opacity-40")} role="group" aria-label="Bot instruments">
                {BOT_SYMBOLS.map((x) => {
                  const on = symbols.includes(x);
                  return <button key={x} type="button" aria-pressed={on} onClick={() => setSymbols(on ? symbols.filter((y) => y !== x) : [...symbols, x])}
                    className={cn("rounded border px-2 py-0.5 text-[11px]", on ? "border-accent/60 bg-accent/10 text-accent" : "border-border text-muted")}>{x}</button>;
                })}
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Expiry" htmlFor="bot-expiry"><Select id="bot-expiry" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
                  {EXPIRIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
                <Field label="Stake % of equity" htmlFor="bot-stake"><Input id="bot-stake" inputMode="decimal" className="num" value={stake} onChange={(e) => setStake(e.target.value)} /></Field>
                <Field label="Min confidence" htmlFor="bot-conf"><Input id="bot-conf" inputMode="decimal" className="num" value={conf} onChange={(e) => setConf(e.target.value)} /></Field>
              </div>
              <RiskModeField value={mode} onChange={setMode}
                practiceNote="Trades the model's best guess whenever it is at least 55% sure, even without a proven edge. Stake capped at 1% of equity." />
              <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                <span><span className="font-medium text-fg">Only trade when the futures model agrees</span>
                  <span className="block text-muted">HIGHER needs the futures model to say LONG, LOWER needs SHORT, each at 55% confidence or more (crypto only). Fewer trades, but only with the bigger trend.</span></span>
              </label>
            </div>
          </details>
        )}

        <div>
          <div className="mb-2 text-xs font-medium text-muted">What the bot decided</div>
          {b.recent.length === 0 ? <p className="text-xs text-subtle">Nothing yet. Start the bot to see its reasoning for every instrument.</p> : (
            <ul className="max-h-72 space-y-2 overflow-y-auto" data-testid="bot-decisions">
              {b.recent.map((c, i) => (
                <li key={i} className="rounded border border-border bg-surface-2 p-2 text-xs">
                  <div className="flex justify-between gap-2"><span className="font-medium">{c.message}</span><span className="num text-subtle">{formatDateTime(c.at)}</span></div>
                  {c.results.map((r: BotCycleResult) => (
                    <div key={r.symbol} className="mt-1 flex items-start gap-2">
                      <Badge tone={OUTCOME[r.outcome]?.[0] ?? "neutral"}>{OUTCOME[r.outcome]?.[1] ?? r.outcome}</Badge>
                      <span className="w-16 shrink-0 font-medium">{r.symbol}</span>
                      <span className="text-muted">{r.outcome === "opened" ? `${r.direction} · stake ${formatMoney(r.stake ?? 0, currency)} · ` : ""}{r.detail}</span>
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-[11px] text-subtle">
          The bot cannot guarantee profit. With an {pct(b.payout_rate, 0)} payout the seller has the edge unless predictions are right more than {pct(b.break_even_win_rate)} of the time.
          Every contract still passes the binary risk gate, and breakers or the kill switch pause the bot.
        </p>
      </CardBody>
    </Card>
  );
}
