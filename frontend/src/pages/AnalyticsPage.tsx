import { BarChart3, Download, FileCheck2, Printer } from "lucide-react";
import { useState } from "react";
import { AnalyticsChart } from "@/charts/AnalyticsChart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Select } from "@/components/ui/form";
import { Stat } from "@/components/ui/stat";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import {
  useAIReport, useExecutionReport, useFullReport, usePerformance, useRiskReport, useTradesReport,
} from "@/features/analytics/hooks";
import { useAccountParam } from "@/features/trading/useAccountParam";
import { cn, formatDateTime, formatMoney } from "@/lib/utils";
import { apiDownload, type AnalyticsPeriod, type Calibration, type FullReport, type GroupRow } from "@/services/api";

const PERIODS: { key: AnalyticsPeriod; label: string }[] = [
  { key: "7d", label: "7 days" }, { key: "30d", label: "30 days" }, { key: "90d", label: "90 days" }, { key: "365d", label: "1 year" }, { key: "all", label: "All time" },
];
const TABS = [["performance", "Performance"], ["trades", "Trades"], ["execution", "Execution"], ["risk", "Risk"], ["ai", "AI quality"], ["report", "Report"]] as const;
type Tab = (typeof TABS)[number][0];
const EXPORTS = [["trades", "Round trips"], ["executions", "Executions"], ["orders", "Orders"], ["ledger", "Ledger"], ["decisions", "Risk decisions"], ["equity", "Equity snapshots"]] as const;

export const pct = (v: number | null | undefined, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const plain = (v: number | null | undefined, d = 2) => (v == null ? "—" : v.toFixed(d));
const tone = (v: number | null | undefined) => (v == null || v === 0 ? "muted" : v > 0 ? "positive" : "negative") as "positive" | "negative" | "muted";
const signed = (v: number, ccy: string) => `${v > 0 ? "+" : ""}${formatMoney(v, ccy)}`;

function Notes({ notes }: { notes: string[] }) {
  return <ul className="space-y-1 text-[11px] text-subtle">{notes.map((n) => <li key={n}>{n}</li>)}</ul>;
}

function Performance({ id, period }: { id: string; period: AnalyticsPeriod }) {
  const [bench, setBench] = useState("SPY");
  const p = usePerformance(id, period, bench);
  if (p.isLoading) return <Spinner className="mx-auto mt-10" />;
  if (!p.data) return <ErrorBanner error={p.error} />;
  const m = p.data.metrics, ccy = p.data.currency;
  const b = p.data.benchmark;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8" data-testid="perf-metrics">
        <Stat label="Return (TWR)" value={pct(m.total_return)} tone={tone(m.total_return)} sub={`${m.periods} daily returns`} />
        <Stat label="vs benchmark" value={b?.available && b.return != null ? pct(m.total_return - b.return) : "—"} tone={tone(b?.available ? m.total_return - (b.return ?? 0) : null)} sub={b?.available ? `${b.symbol} ${pct(b.return)}` : "unavailable"} />
        <Stat label="Sharpe" value={plain(m.sharpe)} tone={m.sharpe == null ? "muted" : undefined} sub="annualised, rf 0" />
        <Stat label="Sortino" value={plain(m.sortino)} tone={m.sortino == null ? "muted" : undefined} />
        <Stat label="Volatility" value={m.volatility == null ? "—" : `${(m.volatility * 100).toFixed(1)}%`} tone="muted" sub="annualised" />
        <Stat label="Max drawdown" value={pct(m.max_drawdown)} tone={m.max_drawdown < 0 ? "negative" : "muted"} sub={`${m.max_drawdown_days} days under water`} />
        <Stat label="CAGR" value={pct(m.cagr)} tone={tone(m.cagr)} sub={m.calmar != null ? `Calmar ${m.calmar.toFixed(2)}` : undefined} />
        <Stat label="Positive days" value={m.positive_days == null ? "—" : `${(m.positive_days * 100).toFixed(0)}%`} tone="muted"
          sub={m.best_day != null ? `best ${pct(m.best_day)} · worst ${pct(m.worst_day)}` : undefined} />
      </div>
      <Card>
        <CardHeader title="Growth and drawdown" description={`Time-weighted, net of virtual deposits and withdrawals · since ${formatDateTime(p.data.since)}`}
          action={<Select aria-label="Benchmark" className="h-8 w-28 text-xs" value={bench} onChange={(e) => setBench(e.target.value)}>
            {["SPY", "QQQ", "BTC-USD", "ISF.L"].map((s) => <option key={s}>{s}</option>)}</Select>} />
        <div className="px-2 pb-3">
          {p.data.daily.length >= 2 ? <AnalyticsChart daily={p.data.daily} benchmark={b?.available ? b.curve : undefined} />
            : <EmptyState title="Not enough history yet">The account needs at least two days of valuations for a growth curve.</EmptyState>}
        </div>
        <CardBody className="border-t border-border pt-3"><Notes notes={p.data.notes} /></CardBody>
      </Card>
      {p.data.daily.length > 0 && (
        <Card>
          <CardHeader title="Daily returns" description="Most recent first" />
          <div className="max-h-[320px] overflow-y-auto">
            <Table>
              <thead><tr><Th>Date</Th><Th className="text-right">Return</Th><Th className="text-right">Cash flow</Th><Th className="text-right">Growth</Th><Th className="text-right">Drawdown</Th></tr></thead>
              <tbody>{[...p.data.daily].reverse().map((d) => (
                <Tr key={d.date}>
                  <Td className="num text-xs">{d.date}</Td>
                  <Td className={cn("num text-right", d.return > 0 && "text-positive", d.return < 0 && "text-negative")}>{pct(d.return, 3)}</Td>
                  <Td className="num text-right text-muted">{d.flow ? formatMoney(d.flow, ccy) : ""}</Td>
                  <Td className="num text-right">{d.growth.toFixed(4)}</Td>
                  <Td className="num text-right text-muted">{pct(d.drawdown)}</Td>
                </Tr>))}</tbody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}

function GroupTable({ title, rows, ccy }: { title: string; rows: GroupRow[]; ccy: string }) {
  return (
    <Card>
      <CardHeader title={title} />
      {rows.length === 0 ? <EmptyState title="No closed trades" /> : (
        <Table>
          <thead><tr><Th>{title.replace("By ", "")}</Th><Th className="text-right">Trades</Th><Th className="text-right">Win rate</Th><Th className="text-right">Net P&L</Th><Th className="text-right">Expectancy</Th></tr></thead>
          <tbody>{rows.map((r) => (
            <Tr key={r.key}>
              <Td className="font-medium capitalize">{r.key}</Td><Td className="num text-right">{r.trades}</Td>
              <Td className="num text-right">{r.win_rate == null ? "—" : `${(r.win_rate * 100).toFixed(0)}%`}</Td>
              <Td className={cn("num text-right", r.net_pnl > 0 && "text-positive", r.net_pnl < 0 && "text-negative")}>{signed(r.net_pnl, ccy)}</Td>
              <Td className="num text-right">{r.expectancy == null ? "—" : formatMoney(r.expectancy, ccy)}</Td>
            </Tr>))}</tbody>
        </Table>
      )}
    </Card>
  );
}

function Trades({ id, period }: { id: string; period: AnalyticsPeriod }) {
  const t = useTradesReport(id, period);
  if (t.isLoading) return <Spinner className="mx-auto mt-10" />;
  if (!t.data) return <ErrorBanner error={t.error} />;
  const s = t.data.stats, ccy = t.data.currency;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="trade-stats">
        <Stat label="Closed trades" value={s.trades} sub={`${t.data.open.positions} still open`} />
        <Stat label="Net P&L" value={signed(s.net_pnl, ccy)} tone={tone(s.net_pnl)} sub={`after ${formatMoney(s.fees, ccy)} fees`} />
        <Stat label="Win rate" value={s.win_rate == null ? "—" : `${(s.win_rate * 100).toFixed(0)}%`} sub={`${s.wins} won · ${s.losses} lost`} />
        <Stat label="Profit factor" value={s.no_losses ? "no losses" : plain(s.profit_factor)} tone={s.profit_factor == null && !s.no_losses ? "muted" : undefined} />
        <Stat label="Expectancy" value={s.expectancy == null ? "—" : formatMoney(s.expectancy, ccy)} tone={tone(s.expectancy)} sub="per trade" />
        <Stat label="Payoff ratio" value={plain(s.payoff_ratio)} sub={`avg ${formatMoney(s.avg_win, ccy)} / ${formatMoney(s.avg_loss, ccy)}`} />
        <Stat label="Avg hold" value={s.avg_hold_hours == null ? "—" : s.avg_hold_hours < 48 ? `${s.avg_hold_hours.toFixed(1)}h` : `${(s.avg_hold_hours / 24).toFixed(1)}d`} tone="muted" />
        <Stat label="Return on cost" value={pct(s.return_on_cost)} tone={tone(s.return_on_cost)} sub={`unrealised ${signed(t.data.open.unrealised_pnl, ccy)}`} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <GroupTable title="By source" rows={t.data.by_source} ccy={ccy} />
        <GroupTable title="By exit" rows={t.data.by_exit} ccy={ccy} />
        <GroupTable title="By symbol" rows={t.data.by_symbol} ccy={ccy} />
        <GroupTable title="By asset class" rows={t.data.by_asset_class} ccy={ccy} />
      </div>
      <Card>
        <CardHeader title="Round trips" description="Opened by: who placed the entry. Exit: how the position closed." />
        {t.data.trades.length === 0 ? <EmptyState title="No closed trades in this period" /> : (
          <Table>
            <thead><tr><Th>Closed</Th><Th>Instrument</Th><Th>Opened by</Th><Th>Exit</Th><Th className="text-right">Held</Th><Th className="text-right">Cost</Th><Th className="text-right">Fees</Th><Th className="text-right">Net P&L</Th></tr></thead>
            <tbody>{t.data.trades.map((r, i) => (
              <Tr key={i}>
                <Td className="num whitespace-nowrap text-xs text-muted">{formatDateTime(r.closed_at)}</Td>
                <Td className="font-medium">{r.symbol}</Td><Td><Badge tone={r.source === "manual" ? "neutral" : "info"}>{r.source}</Badge></Td>
                <Td><Badge tone={r.exit === "stop" ? "negative" : r.exit === "target" ? "positive" : "neutral"}>{r.exit}</Badge></Td>
                <Td className="num text-right text-xs">{r.hold_hours < 48 ? `${r.hold_hours.toFixed(1)}h` : `${(r.hold_hours / 24).toFixed(1)}d`}</Td>
                <Td className="num text-right">{formatMoney(r.cost, ccy)}</Td><Td className="num text-right text-muted">{formatMoney(r.fees, ccy)}</Td>
                <Td className={cn("num text-right", r.pnl > 0 && "text-positive", r.pnl < 0 && "text-negative")}>{signed(r.pnl, ccy)}</Td>
              </Tr>))}</tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function Execution({ id, period }: { id: string; period: AnalyticsPeriod }) {
  const e = useExecutionReport(id, period);
  if (e.isLoading) return <Spinner className="mx-auto mt-10" />;
  if (!e.data) return <ErrorBanner error={e.error} />;
  const t = e.data.total, ccy = e.data.currency;
  const bps = (v: number | null) => (v == null ? "—" : `${v.toFixed(2)} bp`);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="execution-stats">
        <Stat label="Fills" value={t.fills} sub={`${formatMoney(t.notional, ccy, { compact: true })} traded`} />
        <Stat label="All-in cost" value={bps(t.cost_bps)} sub={formatMoney(t.total_cost, ccy)} />
        <Stat label="Fees" value={bps(t.fee_bps)} tone="muted" sub={formatMoney(t.fees, ccy)} />
        <Stat label="Spread" value={bps(t.spread_bps)} tone="muted" sub={formatMoney(t.spread, ccy)} />
        <Stat label="Slippage" value={bps(t.slippage_bps)} tone="muted" sub={formatMoney(t.slippage, ccy)} />
        <Stat label="Fill rate" value={e.data.orders.fill_rate == null ? "—" : `${(e.data.orders.fill_rate * 100).toFixed(0)}%`} sub={`${e.data.orders.total} orders`} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Cost by asset class" description="Basis points of traded notional" />
          {e.data.by_asset_class.length === 0 ? <EmptyState title="No fills" /> : (
            <Table>
              <thead><tr><Th>Class</Th><Th className="text-right">Fills</Th><Th className="text-right">Fees</Th><Th className="text-right">Spread</Th><Th className="text-right">Slippage</Th><Th className="text-right">All-in</Th></tr></thead>
              <tbody>{e.data.by_asset_class.map((r) => (
                <Tr key={r.key}><Td className="font-medium">{r.key}</Td><Td className="num text-right">{r.fills}</Td><Td className="num text-right">{bps(r.fee_bps)}</Td>
                  <Td className="num text-right">{bps(r.spread_bps)}</Td><Td className="num text-right">{bps(r.slippage_bps)}</Td><Td className="num text-right font-medium">{bps(r.cost_bps)}</Td></Tr>))}</tbody>
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader title="Rejections" description="Why orders did not reach the book" />
          {e.data.rejections.length === 0 ? <EmptyState title="No rejections" /> : (
            <ul className="divide-y divide-border/60" data-testid="rejections">{e.data.rejections.map((r) => (
              <li key={r.reason} className="flex justify-between px-5 py-2 text-sm"><span>{r.reason}</span><span className="num">{r.count}</span></li>))}</ul>
          )}
        </Card>
      </div>
      <Card>
        <CardHeader title="Order outcomes by source" />
        <Table>
          <thead><tr><Th>Source</Th>{["FILLED", "OPEN", "REJECTED", "CANCELLED", "EXPIRED"].map((s) => <Th key={s} className="text-right">{s.toLowerCase()}</Th>)}</tr></thead>
          <tbody>{e.data.orders.by_source.map((r) => (
            <Tr key={r.source}><Td className="font-medium capitalize">{r.source}</Td>
              {["FILLED", "OPEN", "REJECTED", "CANCELLED", "EXPIRED"].map((s) => <Td key={s} className="num text-right">{r[s] ?? 0}</Td>)}</Tr>))}</tbody>
        </Table>
        <CardBody className="border-t border-border pt-3"><Notes notes={e.data.notes} /></CardBody>
      </Card>
    </div>
  );
}

function Risk({ id, period }: { id: string; period: AnalyticsPeriod }) {
  const r = useRiskReport(id, period);
  if (r.isLoading) return <Spinner className="mx-auto mt-10" />;
  if (!r.data) return <ErrorBanner error={r.error} />;
  const d = r.data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Gate decisions" value={d.decisions} />
        <Stat label="Approved" value={d.approved} tone="positive" />
        <Stat label="Rejected" value={d.rejected} tone={d.rejected ? "negative" : "muted"} sub={d.decisions ? `${((d.rejected / d.decisions) * 100).toFixed(0)}% of orders` : undefined} />
        <Stat label="Breaker trips" value={d.breaker_trips.length} tone={d.breaker_trips.length ? "negative" : "muted"} />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card><CardHeader title="Checks that refused orders" />
          {d.failed_checks.length === 0 ? <EmptyState title="Nothing refused" /> : <ul className="divide-y divide-border/60">{d.failed_checks.map((c) => (
            <li key={c.check} className="flex justify-between px-5 py-2 text-sm"><span>{c.check}</span><span className="num">{c.count}</span></li>))}</ul>}</Card>
        <Card><CardHeader title="Decisions by source" />
          {d.by_source.length === 0 ? <EmptyState title="No decisions" /> : <Table><thead><tr><Th>Source</Th><Th className="text-right">Approved</Th><Th className="text-right">Rejected</Th></tr></thead>
            <tbody>{d.by_source.map((s) => <Tr key={s.source}><Td className="capitalize">{s.source}</Td><Td className="num text-right">{s.approved}</Td><Td className="num text-right">{s.rejected}</Td></Tr>)}</tbody></Table>}</Card>
        <Card><CardHeader title="Breakers and emergencies" />
          {d.breaker_trips.length === 0 ? <EmptyState title="None in this period" /> : <ol className="divide-y divide-border/60">{d.breaker_trips.map((e, i) => (
            <li key={i} className="px-5 py-2 text-sm"><div className="num text-[11px] text-subtle">{formatDateTime(e.at)}</div>{e.message}</li>))}</ol>}</Card>
      </div>
    </div>
  );
}

function CalibrationTable({ c, label }: { c: Calibration; label: string }) {
  if (!c.n) return <EmptyState title={`No ${label} yet`} />;
  return (
    <>
      <Table>
        <thead><tr><Th>Confidence</Th><Th className="text-right">n</Th><Th className="text-right">Mean confidence</Th><Th className="text-right">Observed hit rate</Th><Th className="text-right">Gap</Th></tr></thead>
        <tbody>{c.bins.map((b) => (
          <Tr key={b.lo}><Td className="num text-xs">{b.lo.toFixed(1)}–{b.hi.toFixed(1)}</Td><Td className="num text-right">{b.n}</Td><Td className="num text-right">{(b.confidence * 100).toFixed(0)}%</Td>
            <Td className="num text-right">{(b.hit_rate * 100).toFixed(0)}%</Td><Td className={cn("num text-right", Math.abs(b.confidence - b.hit_rate) > 0.15 && "text-warning")}>{((b.hit_rate - b.confidence) * 100).toFixed(0)} pts</Td></Tr>))}</tbody>
      </Table>
      <p className="px-5 py-2 text-[11px] text-subtle">Brier {c.brier?.toFixed(3)} · expected calibration error {c.ece?.toFixed(3)} · n = {c.n}</p>
    </>
  );
}

function AIQuality({ id, period }: { id: string; period: AnalyticsPeriod }) {
  const [horizon, setHorizon] = useState(24);
  const a = useAIReport(id, period, horizon);
  if (a.isLoading) return <Spinner className="mx-auto mt-10" />;
  if (!a.data) return <ErrorBanner error={a.error} />;
  const d = a.data, s = d.signals;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2"><span className="text-xs text-muted">Signal horizon</span>
        <Select aria-label="Signal horizon" className="h-8 w-28 text-xs" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
          {[4, 24, 72, 168].map((h) => <option key={h} value={h}>{h < 24 ? `${h} hours` : `${h / 24} day${h > 24 ? "s" : ""}`}</option>)}</Select></div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="ai-stats">
        <Stat label="Agent runs" value={s.runs} sub={`${s.pending} too recent to score`} />
        <Stat label="BUY signals" value={s.buy.n} sub={s.buy.hit_rate == null ? "not scored yet" : `${(s.buy.hit_rate * 100).toFixed(0)}% rose`} />
        <Stat label="BUY fwd return" value={pct(s.buy.avg_forward_return)} tone={tone(s.buy.avg_forward_return)} sub={`after ${horizon}h`} />
        <Stat label="NO TRADE fwd return" value={pct(s.no_trade.avg_forward_return)} tone="muted" sub={`${s.no_trade.n} runs`} />
        <Stat label="Signal edge" value={pct(s.edge)} tone={tone(s.edge)} sub="BUY minus NO TRADE" />
        <Stat label="Proposals executed" value={d.proposals.execution_rate == null ? "—" : `${(d.proposals.execution_rate * 100).toFixed(0)}%`}
          sub={Object.entries(d.proposals.by_status).map(([k, v]) => `${v} ${k.toLowerCase().replaceAll("_", " ")}`).join(" · ") || "none"} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card><CardHeader title="BUY signal calibration" description={`Confidence vs whether the price rose within ${horizon}h`} /><CalibrationTable c={s.buy_calibration} label="scored signals" /></Card>
        <Card><CardHeader title="Executed proposals: realised outcome" description={`${d.realised.closed_trades} closed · net ${d.realised.net_pnl.toFixed(2)}`} /><CalibrationTable c={d.realised.calibration} label="closed AI trades" /></Card>
      </div>
      <Card>
        <CardHeader title="Champion models and drift" description="From the model registry (Phase 6)" />
        {d.models.length === 0 ? <EmptyState title="No champion models">Promote a validated model in the Model Lab.</EmptyState> : (
          <Table><thead><tr><Th>Model</Th><Th>Eligible</Th><Th>Last drift check</Th><Th className="text-right">Max PSI</Th></tr></thead>
            <tbody>{d.models.map((m) => (
              <Tr key={`${m.symbol}${m.version}`}><Td className="font-medium">{m.symbol} v{m.version}</Td><Td><Badge tone={m.eligible ? "positive" : "negative"} title={m.note}>{m.eligible ? "eligible" : "not eligible"}</Badge></Td>
                <Td className="text-xs text-muted">{m.last_drift_check ? `${formatDateTime(m.last_drift_check)} · ${m.drift_status}` : "never"}</Td><Td className="num text-right">{m.max_psi?.toFixed(3) ?? "—"}</Td></Tr>))}</tbody></Table>
        )}
        <CardBody className="border-t border-border pt-3"><Notes notes={d.notes} /></CardBody>
      </Card>
    </div>
  );
}

export function ReportView({ r }: { r: FullReport }) {
  const ccy = r.account.currency, m = r.performance.metrics, t = r.trades.stats;
  const rows: [string, string][] = [
    ["Equity", formatMoney(r.snapshot.equity, ccy)], ["Cash", formatMoney(r.snapshot.cash, ccy)], ["Open positions", String(r.snapshot.open_positions)],
    ["Return (TWR)", pct(m.total_return)], ["Sharpe", plain(m.sharpe)], ["Sortino", plain(m.sortino)], ["Max drawdown", pct(m.max_drawdown)],
    ["Closed trades", String(t.trades)], ["Win rate", t.win_rate == null ? "—" : `${(t.win_rate * 100).toFixed(0)}%`], ["Net trading P&L", signed(t.net_pnl, ccy)],
    ["Profit factor", t.no_losses ? "no losses" : plain(t.profit_factor)], ["All-in execution cost", r.execution.total.cost_bps == null ? "—" : `${r.execution.total.cost_bps.toFixed(2)} bp`],
    ["Risk decisions", `${r.risk.approved} approved · ${r.risk.rejected} rejected`], ["Breaker trips", String(r.risk.breaker_trips.length)],
    ["AI signal edge", pct(r.ai.signals.edge)], ["Proposals executed", r.ai.proposals.execution_rate == null ? "—" : `${(r.ai.proposals.execution_rate * 100).toFixed(0)}%`],
  ];
  return (
    <div className="space-y-4" data-testid="report">
      <div>
        <h2 className="text-lg font-semibold">{r.report}</h2>
        <p className="text-xs text-muted">{r.account.name} ({r.account.currency}, {r.account.mode}) · {r.account.owner} · period {r.period} · generated {formatDateTime(r.generated_at)}</p>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
        {rows.map(([k, v]) => <div key={k}><dt className="text-[11px] text-subtle">{k}</dt><dd className="num">{v}</dd></div>)}
      </dl>
      <div className={cn("rounded-md border px-3 py-2 text-xs", r.integrity.ledger_balanced ? "border-positive/40 text-positive" : "border-negative/40 text-negative")}>
        {r.integrity.ledger_balanced ? "Ledger balanced (debits = credits) at generation time." : "Ledger imbalance detected."}
      </div>
      <p className="break-all text-[11px] text-subtle">SHA-256 of report content: <span className="num" data-testid="report-hash">{r.sha256}</span></p>
      <p className="text-[11px] text-subtle">{r.disclaimer}</p>
    </div>
  );
}

function Report({ id, period, name }: { id: string; period: AnalyticsPeriod; name: string }) {
  const [on, setOn] = useState(false);
  const r = useFullReport(id, period, on);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const dl = async (path: string, file: string) => {
    setBusy(file); setErr(null);
    try { await apiDownload(path, file); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
      <Card className="print:border-0">
        <CardHeader title="Performance report" description="Summarises every section for the selected period, with a content hash for later verification"
          action={<div className="flex gap-2 print:hidden">
            <Button size="sm" onClick={() => (on ? r.refetch() : setOn(true))} disabled={r.isFetching}>{r.isFetching ? <Spinner /> : <FileCheck2 />}Generate</Button>
            {r.data && <Button size="sm" variant="outline" onClick={() => window.print()}><Printer />Print / PDF</Button>}
          </div>} />
        <CardBody>
          <ErrorBanner error={r.error ?? err} />
          {r.data ? <ReportView r={r.data} /> : !r.isFetching && <EmptyState icon={<FileCheck2 />} title="No report generated">Generating a report is recorded in the audit log.</EmptyState>}
        </CardBody>
      </Card>
      <Card className="print:hidden">
        <CardHeader title="Exports" description={`CSV for ${name}, period ${period}. Each export is audited.`} />
        <CardBody className="space-y-2">
          {EXPORTS.map(([k, label]) => (
            <Button key={k} variant="secondary" size="sm" className="w-full justify-start" disabled={!!busy}
              onClick={() => dl(`/analytics/accounts/${id}/export/${k}.csv?period=${period}`, `aurex-${k}.csv`)}>
              {busy === `aurex-${k}.csv` ? <Spinner /> : <Download />}{label} (CSV)</Button>))}
          <Button variant="secondary" size="sm" className="w-full justify-start" disabled={!!busy}
            onClick={() => dl(`/analytics/accounts/${id}/report?period=${period}&download=true`, "aurex-report.json")}><Download />Full report (JSON)</Button>
        </CardBody>
      </Card>
    </div>
  );
}

export function AnalyticsPage() {
  const { accounts, list, account, select, params, setParams } = useAccountParam();
  const period = (params.get("period") as AnalyticsPeriod) || "30d";
  const tab = (params.get("tab") as Tab) || "performance";
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); n.set(k, v); setParams(n); };
  if (accounts.isLoading) return <Spinner className="mx-auto mt-16" />;
  if (!account) return <Card><EmptyState icon={<BarChart3 />} title="No paper accounts">Create a paper account and trade to see analytics.</EmptyState></Card>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <div className="w-full sm:w-72">
          <Field label="Paper account" htmlFor="an-acct">
            <Select id="an-acct" value={account.id} onChange={(e) => select(e.target.value)}>
              {list.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.base_currency}</option>)}
            </Select>
          </Field>
        </div>
        <div className="flex rounded-md bg-surface p-0.5" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p.key} aria-pressed={period === p.key} onClick={() => set("period", p.key)}
              className={cn("rounded px-3 py-1.5 text-xs", period === p.key ? "bg-surface-3 text-fg" : "text-muted hover:text-fg")}>{p.label}</button>))}
        </div>
      </div>
      <div className="flex gap-1 overflow-x-auto rounded-md bg-surface p-1 print:hidden" role="tablist" style={{ width: "fit-content", maxWidth: "100%" }}>
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => set("tab", k)}
            className={cn("whitespace-nowrap rounded px-4 py-1.5 text-sm", tab === k ? "bg-surface-3 text-fg" : "text-muted hover:text-fg")}>{label}</button>))}
      </div>
      {tab === "performance" && <Performance id={account.id} period={period} />}
      {tab === "trades" && <Trades id={account.id} period={period} />}
      {tab === "execution" && <Execution id={account.id} period={period} />}
      {tab === "risk" && <Risk id={account.id} period={period} />}
      {tab === "ai" && <AIQuality id={account.id} period={period} />}
      {tab === "report" && <Report id={account.id} period={period} name={account.name} />}
    </div>
  );
}
