import { AlertTriangle, History, Play } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { BacktestChart } from "@/charts/BacktestChart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { useBacktest, useBacktests, useRunBacktest, useStrategies } from "@/features/backtest/hooks";
import { useMarketOverview } from "@/features/markets/hooks";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";
import type { BacktestRun, BtMetrics } from "@/services/api";

const pct = (v: number | null | undefined, d = 2) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const num = (v: number | null | undefined, d = 2) => (v == null ? "—" : v.toFixed(d));
const money = (v: number) => v.toLocaleString("en-GB", { maximumFractionDigits: 0 });

function ConfigPanel({ onRun }: { onRun: (id: string) => void }) {
  const strategies = useStrategies();
  const overview = useMarketOverview();
  const runBt = useRunBacktest();
  const [key, setKey] = useState("sma_crossover");
  const [symbol, setSymbol] = useState("BTC-USD");
  const [days, setDays] = useState("180");
  const [optimise, setOptimise] = useState(true);
  const [params, setParams] = useState<Record<string, string>>({});
  const [costs, setCosts] = useState({ fee_bps: "", half_spread_bps: "", slippage_bps: "", latency_bars: "1" });
  const spec = strategies.data?.find((s) => s.key === key);
  const instruments = Object.values(overview.data?.groups ?? {}).flat().map((g) => g.instrument.symbol);
  useEffect(() => { if (spec) setParams(Object.fromEntries(Object.entries(spec.defaults).map(([k, v]) => [k, String(v)]))); }, [spec]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const c = Object.fromEntries(Object.entries(costs).filter(([, v]) => v !== "").map(([k, v]) => [k, Number(v)]));
    const r = await runBt.mutateAsync({ strategy: key, symbol, days: +days, optimise, costs: c,
      params: optimise ? undefined : Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Number(v)])) });
    onRun(r.id);
  }
  return (
    <Card>
      <CardHeader title="Configure backtest" description="Event-driven, hourly bars, realistic costs" />
      <CardBody>
        <form onSubmit={submit} className="space-y-3">
          <ErrorBanner error={runBt.error} />
          <Field label="Strategy" htmlFor="bt-strategy">
            <Select id="bt-strategy" value={key} onChange={(e) => setKey(e.target.value)}>
              {(strategies.data ?? []).map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
            </Select>
          </Field>
          <p className="text-[11px] leading-relaxed text-subtle">{spec?.description}</p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Instrument" htmlFor="bt-sym"><Select id="bt-sym" value={symbol} onChange={(e) => setSymbol(e.target.value)}>{instruments.map((s) => <option key={s}>{s}</option>)}</Select></Field>
            <Field label="Period" htmlFor="bt-days"><Select id="bt-days" value={days} onChange={(e) => setDays(e.target.value)}>{[60, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}</Select></Field>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 accent-[var(--color-accent)]" checked={optimise} onChange={(e) => setOptimise(e.target.checked)} />
            <span>Optimise in-sample<span className="block text-[11px] text-subtle">{spec ? `${spec.grid_size} parameter sets on the first 60%; the best is tested once on the last 40%` : ""}</span></span>
          </label>
          {!optimise && spec && (
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(spec.params).map(([k, rule]) => (
                <Field key={k} label={k} htmlFor={`bt-p-${k}`}>
                  <Input id={`bt-p-${k}`} type="number" step={rule.type === "int" ? 1 : 0.01} min={rule.min} max={rule.max} value={params[k] ?? ""} onChange={(e) => setParams({ ...params, [k]: e.target.value })} />
                </Field>
              ))}
            </div>
          )}
          <details className="rounded-md border border-border px-3 py-2">
            <summary className="cursor-pointer text-xs text-muted">Execution costs (defaults per asset class)</summary>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {([["fee_bps", "Fee (bps/side)"], ["half_spread_bps", "Half spread (bps)"], ["slippage_bps", "Slippage (bps)"], ["latency_bars", "Latency (bars)"]] as const).map(([k, label]) => (
                <Field key={k} label={label} htmlFor={`bt-${k}`}><Input id={`bt-${k}`} type="number" min={k === "latency_bars" ? 1 : 0} step="0.1" placeholder="default" value={costs[k]} onChange={(e) => setCosts({ ...costs, [k]: e.target.value })} /></Field>
              ))}
            </div>
          </details>
          <Button type="submit" className="w-full" disabled={runBt.isPending}>{runBt.isPending ? <Spinner className="text-accent-fg" /> : <Play />}{runBt.isPending ? "Simulating…" : "Run backtest"}</Button>
        </form>
      </CardBody>
    </Card>
  );
}

function HistoryList({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const list = useBacktests();
  const items = list.data?.items ?? [];
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><History className="size-4" />History</span>} />
      {items.length === 0 ? <EmptyState title="No backtests yet" /> : (
        <ul className="max-h-[360px] divide-y divide-border/60 overflow-y-auto">
          {items.map((b) => (
            <li key={b.id}>
              <button onClick={() => onSelect(b.id)} className={cn("w-full px-4 py-2.5 text-left hover:bg-surface-2", selected === b.id && "bg-surface-3")}>
                <p className="text-sm">{b.strategy_key.replace(/_/g, " ")} · {b.symbol}</p>
                <p className="num text-[11px] text-subtle">OOS {pct(b.oos_return)} · Sharpe {num(b.oos_sharpe)} · {relativeTime(b.created_at)}</p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const ROWS: [keyof BtMetrics, string, (v: never) => string][] = [
  ["total_return", "Total return", pct as never], ["cagr", "CAGR", pct as never], ["sharpe", "Sharpe", num as never],
  ["sortino", "Sortino", num as never], ["max_drawdown", "Max drawdown", ((v: number) => pct(-v)) as never], ["calmar", "Calmar", num as never],
  ["volatility", "Volatility (ann.)", ((v: number) => `${(v * 100).toFixed(1)}%`) as never], ["trades", "Trades", String as never],
  ["win_rate", "Win rate", ((v: number) => `${(v * 100).toFixed(0)}%`) as never], ["profit_factor", "Profit factor", num as never],
  ["exposure", "Exposure", ((v: number) => `${(v * 100).toFixed(0)}%`) as never], ["fees", "Fees paid", money as never],
  ["slippage_and_spread", "Spread & slippage", money as never],
];

function ResultView({ bt }: { bt: BacktestRun }) {
  const r = bt.result;
  const cols = [["IS strategy", r.in_sample.strategy], ["IS buy & hold", r.in_sample.buy_hold], ["OOS strategy", r.out_of_sample.strategy], ["OOS buy & hold", r.out_of_sample.buy_hold]] as const;
  return (
    <div className="space-y-4" aria-label="Backtest result">
      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-subtle">{bt.config.asset_class} · 1h bars · {formatDateTime(bt.period_from)} → {formatDateTime(bt.period_to)}</p>
              <h2 className="mt-1 text-lg font-semibold">{bt.strategy_key.replace(/_/g, " ")} · {bt.symbol}</h2>
              <p className="num mt-1 text-xs text-muted">params {JSON.stringify(r.params)} {r.optimised && <Badge tone="info" className="ml-1">optimised in-sample</Badge>} · capital {money(bt.config.capital)} · {bt.latency_ms} ms</p>
            </div>
            <div className="text-right" data-testid="oos-headline">
              <p className="text-[11px] uppercase tracking-wider text-subtle">Out-of-sample</p>
              <p className={cn("num text-2xl font-semibold", r.out_of_sample.strategy.total_return >= 0 ? "text-positive" : "text-negative")}>{pct(r.out_of_sample.strategy.total_return)}</p>
              <p className="num text-xs text-muted">Sharpe {num(r.out_of_sample.strategy.sharpe)} · buy & hold {pct(r.out_of_sample.buy_hold.total_return)}</p>
            </div>
          </div>
          {r.warnings.length > 0 && (
            <ul className="space-y-1 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {r.warnings.map((w) => <li key={w} className="flex gap-2"><AlertTriangle className="mt-px size-3.5 shrink-0" />{w}</li>)}
            </ul>
          )}
          <p className="text-[11px] text-subtle">
            Costs: fee {bt.config.costs.fee_bps} bps/side, half-spread {bt.config.costs.half_spread_bps} bps, slippage {bt.config.costs.slippage_bps} bps + {bt.config.costs.vol_slippage}× bar volatility, latency {bt.config.costs.latency_bars} bar(s).
            Risk: {(bt.config.risk.risk_per_trade! * 100).toFixed(1)}% per trade, stop {bt.config.risk.stop_atr} ATR, target {bt.config.risk.target_atr} ATR, position ≤ {(bt.config.risk.max_position_pct! * 100).toFixed(0)}% of equity, daily loss halt {(bt.config.risk.daily_loss_limit! * 100).toFixed(0)}%, drawdown circuit breaker {(bt.config.risk.max_drawdown! * 100).toFixed(0)}%.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Equity and drawdown" description={`Strategy (gold) vs buy & hold (blue); out-of-sample from ${formatDateTime(r.split_time)}`} />
        <CardBody><BacktestChart strategy={r.curves.strategy} benchmark={r.curves.buy_hold} split={r.split_time} /></CardBody>
      </Card>

      <Card>
        <CardHeader title="In-sample vs out-of-sample" description={`Sharpe degradation ${r.degradation.sharpe >= 0 ? "+" : ""}${r.degradation.sharpe.toFixed(2)}; judge the strategy on the out-of-sample columns`} />
        <Table data-testid="metrics-table">
          <thead><tr><Th>Metric</Th>{cols.map(([label]) => <Th key={label} className={cn("text-right", label.startsWith("OOS") && "text-accent")}>{label}</Th>)}</tr></thead>
          <tbody>
            {ROWS.map(([k, label, fmt]) => (
              <Tr key={k}><Td className="text-xs text-muted">{label}</Td>{cols.map(([c, m]) => <Td key={c} className={cn("num text-right text-xs", c.startsWith("OOS") && "font-medium")}>{(fmt as (v: unknown) => string)(m[k])}</Td>)}</Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {r.grid.length > 0 && (
        <Card>
          <CardHeader title="In-sample parameter sensitivity" description="Only in-sample data was used to choose; a smooth surface is more trustworthy than a single spike" />
          <Table>
            <thead><tr><Th>Parameters</Th><Th className="text-right">Sharpe</Th><Th className="text-right">Return</Th><Th className="text-right">Max DD</Th><Th className="text-right">Trades</Th></tr></thead>
            <tbody>
              {r.grid.map((g) => {
                const chosen = JSON.stringify(g.params) === JSON.stringify(r.params);
                return (
                  <Tr key={JSON.stringify(g.params)} className={cn(chosen && "bg-accent/10")}>
                    <Td className="num text-xs">{JSON.stringify(g.params)} {chosen && <Badge tone="accent">chosen</Badge>}</Td>
                    <Td className="num text-right text-xs">{num(g.sharpe)}</Td><Td className="num text-right text-xs">{pct(g.total_return)}</Td>
                    <Td className="num text-right text-xs">{pct(-g.max_drawdown)}</Td><Td className="num text-right text-xs">{g.trades}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title="Trades" description={`${r.full.trades} over the full period (showing the latest ${Math.min(50, r.trades.length)})`} />
          {r.trades.length === 0 ? <EmptyState title="No trades" /> : (
            <Table>
              <thead><tr><Th>Entry</Th><Th>Exit</Th><Th className="text-right">Entry px</Th><Th className="text-right">Exit px</Th><Th className="text-right">P&L</Th><Th>Reason</Th></tr></thead>
              <tbody>
                {r.trades.slice(-50).reverse().map((t, i) => (
                  <Tr key={i}>
                    <Td className="num whitespace-nowrap text-xs text-muted">{formatDateTime(t.entry_time)}</Td>
                    <Td className="num whitespace-nowrap text-xs text-muted">{t.exit_time ? formatDateTime(t.exit_time) : "—"}</Td>
                    <Td className="num text-right text-xs">{t.entry_price.toPrecision(6)}</Td>
                    <Td className="num text-right text-xs">{t.exit_price?.toPrecision(6) ?? "—"}</Td>
                    <Td className={cn("num text-right text-xs", t.pnl >= 0 ? "text-positive" : "text-negative")}>{t.pnl >= 0 ? "+" : ""}{money(t.pnl)}</Td>
                    <Td><Badge tone={t.exit_reason === "stop" ? "negative" : t.exit_reason === "target" ? "positive" : "neutral"}>{t.exit_reason.replace(/_/g, " ")}</Badge></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader title="Risk events" description="Daily loss limit and drawdown circuit breaker" />
          {r.events.length === 0 ? <EmptyState title="No risk limits were breached" /> : (
            <ul className="divide-y divide-border/60">
              {r.events.slice(0, 30).map((e, i) => (
                <li key={i} className="px-5 py-2.5 text-xs"><Badge tone="negative">{e.type.replace(/_/g, " ")}</Badge><p className="mt-1 text-muted">{e.detail}</p><p className="num text-[11px] text-subtle">{formatDateTime(e.time)}</p></li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

export function BacktestPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("run");
  const bt = useBacktest(selected);
  const select = (id: string) => setParams({ run: id });
  return (
    <div className="grid gap-4 xl:grid-cols-[340px_1fr]">
      <div className="space-y-4"><ConfigPanel onRun={select} /><HistoryList selected={selected} onSelect={select} /></div>
      <div className="min-w-0">
        {bt.data ? <ResultView bt={bt.data} /> : bt.isLoading ? <Spinner className="mx-auto mt-16" /> : (
          <Card><EmptyState icon={<Play />} title="Run a backtest">
            Orders fill at the next bar's open after the chosen latency, with spread, slippage and fees. Stops gap realistically, sessions close, and the blueprint's daily loss and drawdown limits are enforced.
          </EmptyState></Card>
        )}
      </div>
    </div>
  );
}
