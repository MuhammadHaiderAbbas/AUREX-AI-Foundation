import { Briefcase, CandlestickChart, PieChart, Plus } from "lucide-react";
import { app } from "@/lib/paths";
import { useState } from "react";
import { Link } from "react-router-dom";
import { PortfolioChart } from "@/charts/PortfolioChart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Select } from "@/components/ui/form";
import { Stat } from "@/components/ui/stat";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { CreateAccountDialog } from "@/features/accounts/CreateAccountDialog";
import { OrderTicket } from "@/features/trading/OrderTicket";
import { useLiveEquity } from "@/features/live/stream";
import { useClosedPositions, usePortfolio, usePortfolioHistory } from "@/features/trading/hooks";
import { useAccountParam } from "@/features/trading/useAccountParam";
import { cn, formatDateTime, formatMoney, formatPrice } from "@/lib/utils";
import type { Position } from "@/services/api";

const CLASS_LABEL: Record<string, string> = { CRYPTO: "Crypto", FX: "Forex", STOCK: "Stocks", ETF: "ETFs", BINARY: "Binary options (at stake)", CASH: "Cash" };
const tone = (v: string | number) => (Number(v) > 0 ? "positive" : Number(v) < 0 ? "negative" : "muted") as "positive" | "negative" | "muted";
const signed = (v: string, ccy: string) => `${Number(v) > 0 ? "+" : ""}${formatMoney(v, ccy)}`;

export function PortfolioPage() {
  const { accounts, list, account, select } = useAccountParam();
  const summary = usePortfolio(account?.id);
  const history = usePortfolioHistory(account?.id);
  const closed = useClosedPositions(account?.id);
  const liveEquity = useLiveEquity(account?.id);
  const [ticket, setTicket] = useState<{ symbol: string; side: "BUY" | "SELL"; quantity: string } | null>(null);
  const [creating, setCreating] = useState(false);

  if (accounts.isLoading) return <Spinner className="mx-auto mt-16" />;
  if (!account) {
    return (
      <Card>
        <EmptyState icon={<PieChart />} title="No paper accounts">
          Create a paper account to start trading with virtual capital.
          <div className="mt-4"><Button size="sm" onClick={() => setCreating(true)}><Plus />Create paper account</Button></div>
        </EmptyState>
        <CreateAccountDialog open={creating} onClose={() => setCreating(false)} onCreated={select} />
      </Card>
    );
  }
  const s = summary.data;
  const ccy = account.base_currency;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-72">
          <Field label="Paper account" htmlFor="pf-acct">
            <Select id="pf-acct" value={account.id} onChange={(e) => select(e.target.value)}>
              {list.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.base_currency}</option>)}
            </Select>
          </Field>
        </div>
        <Link to={app("/trade")}><Button variant="secondary"><CandlestickChart />Trade now</Button></Link>
        <Badge tone="accent" className="ml-auto">Paper trading · virtual capital</Badge>
      </div>
      <ErrorBanner error={summary.error ?? history.error} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Equity" className="col-span-2 md:col-span-1" value={s ? formatMoney(s.equity, ccy) : "—"} sub="Cash + positions at the bid" />
        <Stat label="Cash" value={s ? formatMoney(s.cash, ccy) : "—"} sub={s ? `${formatMoney(s.available_cash, ccy)} available` : undefined} />
        <Stat label="Market value" value={s ? formatMoney(s.market_value, ccy) : "—"} sub={s ? `Cost ${formatMoney(s.investments_at_cost, ccy)}` : undefined} />
        <Stat label="Unrealised P&L" value={s ? signed(s.unrealised_pnl, ccy) : "—"} tone={s ? tone(s.unrealised_pnl) : "muted"} />
        <Stat label="Realised P&L" value={s ? signed(s.realised_pnl, ccy) : "—"} tone={s ? tone(s.realised_pnl) : "muted"} sub={s ? `Fees ${formatMoney(s.fees, ccy)}` : undefined} />
        <Stat label="Exposure" value={s ? `${(s.exposure * 100).toFixed(1)}%` : "—"} sub={s ? `${s.open_positions} of 5 positions` : undefined} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader title="Open positions" description="Marked to the live bid, converted to the account currency" />
          {summary.isLoading ? <div className="p-8"><Spinner className="mx-auto" /></div> : (s?.positions.length ?? 0) === 0 ? (
            <EmptyState icon={<Briefcase />} title="No open positions">Place a paper order from the Markets screen.</EmptyState>
          ) : (
            <Table>
              <thead><tr><Th>Instrument</Th><Th className="text-right">Qty</Th><Th className="text-right">Avg price</Th><Th className="text-right">Bid</Th>
                <Th className="text-right">Value</Th><Th className="text-right">Unrealised</Th><Th /></tr></thead>
              <tbody>
                {s!.positions.map((p) => <PositionRow key={p.id} p={p} ccy={ccy} onClose={() => setTicket({ symbol: p.symbol, side: "SELL", quantity: Number(p.quantity).toString() })} />)}
              </tbody>
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader title="Allocation" description="Share of equity by asset class" />
          <CardBody className="space-y-3">
            {s && [...Object.entries(s.allocation), ["CASH", Number(s.equity) ? Number(s.cash) / Number(s.equity) : 1] as [string, number]].map(([k, v]) => (
              <div key={k}>
                <div className="flex justify-between text-xs"><span>{CLASS_LABEL[k] ?? k}</span><span className="num">{(v * 100).toFixed(1)}%</span></div>
                <div className="mt-1 h-1.5 rounded bg-surface-3"><div className={cn("h-full rounded", k === "CASH" ? "bg-subtle" : "bg-accent")} style={{ width: `${Math.max(0, Math.min(100, v * 100))}%` }} /></div>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Equity" description="Snapshots on every fill and hourly, then live mark-to-market every 2 seconds" />
        <div className="px-2 pb-3">
          {(history.data?.length ?? 0) + liveEquity.length >= 2
            ? <PortfolioChart snapshots={history.data ?? []} live={liveEquity} />
            : <EmptyState title="Waiting for live valuations">The curve starts within a few seconds.</EmptyState>}
        </div>
      </Card>

      <Card>
        <CardHeader title="Closed positions" description="Most recent first" action={<Link to={app(`/history?account=${account.id}`)} className="text-xs text-accent hover:underline">Full trade history</Link>} />
        {(closed.data?.length ?? 0) === 0 ? <EmptyState title="No closed positions" /> : (
          <Table>
            <thead><tr><Th>Instrument</Th><Th>Opened</Th><Th>Closed</Th><Th className="text-right">Fees</Th><Th className="text-right">Realised P&L</Th></tr></thead>
            <tbody>
              {closed.data!.map((p) => (
                <Tr key={p.id}>
                  <Td className="font-medium">{p.symbol}</Td>
                  <Td className="num text-xs text-muted">{formatDateTime(p.opened_at)}</Td>
                  <Td className="num text-xs text-muted">{p.closed_at ? formatDateTime(p.closed_at) : "—"}</Td>
                  <Td className="num text-right">{formatMoney(p.fees, ccy)}</Td>
                  <Td className={cn("num text-right", Number(p.realised_pnl) > 0 && "text-positive", Number(p.realised_pnl) < 0 && "text-negative")}>{signed(p.realised_pnl, ccy)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {ticket && <OrderTicket open onClose={() => setTicket(null)} accountId={account.id} {...ticket} />}
    </div>
  );
}

function PositionRow({ p, ccy, onClose }: { p: Position; ccy: string; onClose: () => void }) {
  const t = tone(p.unrealised_pnl);
  return (
    <Tr>
      <Td><div className="font-medium">{p.symbol}</div><div className="text-[11px] text-subtle">{CLASS_LABEL[p.asset_class]} · {p.quote_currency}{p.stale && " · stale price"}</div></Td>
      <Td className="num text-right">{Number(p.quantity).toLocaleString("en-GB", { maximumFractionDigits: 8 })}</Td>
      <Td className="num text-right">{formatPrice(p.avg_price, p.price_decimals)}</Td>
      <Td className="num text-right">{formatPrice(p.bid, p.price_decimals)}</Td>
      <Td className="num text-right">{formatMoney(p.market_value, ccy)}</Td>
      <Td className={cn("num text-right", t === "positive" && "text-positive", t === "negative" && "text-negative")}>
        {signed(p.unrealised_pnl, ccy)}<div className="text-[11px]">{(p.unrealised_pct * 100).toFixed(2)}%</div>
      </Td>
      <Td className="text-right"><Button size="sm" variant="outline" onClick={onClose} aria-label={`Close ${p.symbol}`}>Close</Button></Td>
    </Tr>
  );
}
