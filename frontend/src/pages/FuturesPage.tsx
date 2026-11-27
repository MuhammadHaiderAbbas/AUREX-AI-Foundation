import { AlertTriangle, ArrowDown, ArrowUp, BrainCircuit } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { Stat } from "@/components/ui/stat";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { FuturesBotPanel } from "@/features/futures/FuturesBotPanel";
import { useCloseFutures, useFuturesBook, useFuturesConfig, useFuturesPositions, useFuturesPreview, useFuturesSignal, useOpenFutures } from "@/features/futures/hooks";
import { useMarketOverview } from "@/features/markets/hooks";
import { usePortfolio } from "@/features/trading/hooks";
import { useAccountParam } from "@/features/trading/useAccountParam";
import { cn, formatDateTime, formatMoney, formatPrice } from "@/lib/utils";
import { ChecksList } from "@/pages/RiskPage";
import { ApiError, type FuturesPosition, type FuturesSide, type RiskCheck } from "@/services/api";

const n = (v: unknown) => (v == null || v === "" ? null : Math.abs(Number(v)) < 0.005 ? 0 : Number(v));
const pct = (v: number | null | undefined, dp = 2) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(dp)}%`);
const STATUS_TONE = { OPEN: "info", CLOSED: "neutral", LIQUIDATED: "negative" } as const;

function Disclaimer({ notice }: { notice?: string }) {
  return (
    <div role="note" aria-label="Leverage warning" className="flex gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
      <div className="space-y-1">
        <div className="font-semibold">Paper simulation of perpetual futures — virtual money only</div>
        <p className="text-muted">{notice ?? "Leverage multiplies gains and losses: at 10x a 10% move against you wipes out the margin. Most retail traders lose money on leveraged crypto products."}</p>
      </div>
    </div>
  );
}

function OrderBook({ symbol, decimals }: { symbol: string; decimals: number }) {
  const book = useFuturesBook(symbol);
  const b = book.data;
  const rows = (side: [string, string][]) => { let cum = 0; return side.map(([p, q]) => { cum += Number(q); return { p: Number(p), q: Number(q), cum }; }); };
  const asks = b ? rows(b.asks) : [], bids = b ? rows(b.bids) : [];
  const max = Math.max(asks.at(-1)?.cum ?? 0, bids.at(-1)?.cum ?? 0, 1e-12);
  const spread = asks[0] && bids[0] ? asks[0].p - bids[0].p : null;
  const Row = ({ r, tone }: { r: { p: number; q: number; cum: number }; tone: "positive" | "negative" }) => (
    <div className="relative grid grid-cols-3 px-3 py-0.5 text-xs num">
      <div className={cn("absolute inset-y-0 right-0", tone === "positive" ? "bg-positive/10" : "bg-negative/10")} style={{ width: `${(r.cum / max) * 100}%` }} />
      <span className={cn("relative", tone === "positive" ? "text-positive" : "text-negative")}>{formatPrice(r.p, decimals)}</span>
      <span className="relative text-right">{r.q.toFixed(4)}</span>
      <span className="relative text-right text-muted">{r.cum.toFixed(4)}</span>
    </div>
  );
  return (
    <Card data-testid="order-book" data-tour="order-book">
      <CardHeader title="Order book" description="Your order fills level by level, so bigger orders get worse prices"
        action={b && <Badge tone={b.source === "coinbase" ? "positive" : "neutral"} title={b.source === "coinbase" ? "Live Coinbase level-2 book" : "Built around the current quote"}>{b.source === "coinbase" ? "Live · Coinbase" : "Synthetic"}</Badge>} />
      <div className="pb-3">
        <div className="grid grid-cols-3 px-3 pb-1 text-[11px] text-subtle"><span>Price</span><span className="text-right">Size</span><span className="text-right">Total</span></div>
        {!b ? <div className="p-6 text-center"><Spinner /></div> : (
          <>
            {[...asks].reverse().map((r, i) => <Row key={`a${i}`} r={r} tone="negative" />)}
            <div className="my-1 border-y border-border px-3 py-1 text-xs text-muted">Spread <span className="num">{spread == null ? "—" : formatPrice(spread, decimals)}</span></div>
            {bids.map((r, i) => <Row key={`b${i}`} r={r} tone="positive" />)}
          </>
        )}
      </div>
    </Card>
  );
}

function SignalCard({ symbol, onUse }: { symbol: string; onUse: (side: FuturesSide, lev: number) => void }) {
  const [asked, setAsked] = useState(false);
  const sig = useFuturesSignal(symbol, asked);
  const d = sig.data?.symbol === symbol ? sig.data : undefined;
  return (
    <Card data-testid="futures-signal" data-tour="futures-ai">
      <CardHeader title="AI futures model" description="LONG, SHORT or no trade over the next 4 hours, tested after fees and funding" />
      <CardBody className="space-y-3 text-sm">
        {!asked ? <Button variant="secondary" onClick={() => setAsked(true)}><BrainCircuit />Analyse {symbol}</Button>
          : sig.isFetching && !d ? <div className="flex items-center gap-2 text-muted"><Spinner />Training on {symbol} hourly history and testing out of sample…</div>
          : sig.error ? <ErrorBanner error={sig.error} />
          : d && (
            <>
              <div className="flex items-center gap-2">
                <Badge tone={d.trade ? (d.direction === "LONG" ? "positive" : "negative") : "neutral"} data-testid="futures-signal-verdict">
                  {d.trade ? `${d.direction} · ${d.suggested_leverage}x` : "No trade"}
                </Badge>
                <span className="text-xs text-subtle">{d.bars} hourly bars{d.data_mode ? ` · ${d.data_mode}` : ""}</span>
              </div>
              <p className="text-muted">{d.reason}</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <dt className="text-subtle">Out-of-sample trades</dt><dd className="num text-right">{d.trades}</dd>
                <dt className="text-subtle">Hit rate</dt><dd className="num text-right">{d.hit_rate == null ? "—" : `${(d.hit_rate * 100).toFixed(1)}%`}</dd>
                <dt className="text-subtle">Avg return after costs</dt><dd className="num text-right">{pct(d.mean_return)}</dd>
                <dt className="text-subtle">95% lower bound</dt><dd className="num text-right">{pct(d.return_lower)}</dd>
                <dt className="text-subtle">Profitable periods</dt><dd className="num text-right">{d.folds_profitable} / {d.folds}</dd>
                <dt className="text-subtle">Cost per trade</dt><dd className="num text-right">{(d.cost_per_trade * 100).toFixed(3)}%</dd>
                <dt className="text-subtle">Now</dt><dd className="num text-right">{d.confidence == null ? "—" : `${(d.confidence * 100).toFixed(0)}% ${d.direction}`}</dd>
                <dt className="text-subtle">Volatility-based leverage</dt><dd className="num text-right">{d.suggested_leverage ?? "—"}x</dd>
              </dl>
              {d.trade && d.direction && <Button size="sm" onClick={() => onUse(d.direction!, d.suggested_leverage ?? 1)}>Use in the ticket</Button>}
              <p className="text-[11px] text-subtle">It only suggests a trade when the 95% lower bound of its tested return is above zero after costs. Most of the time the honest answer is “no trade”.</p>
            </>
          )}
      </CardBody>
    </Card>
  );
}

function PositionRows({ rows, ccy, onClose, closing }: { rows: FuturesPosition[]; ccy: string; onClose?: (id: string) => void; closing?: string | null }) {
  return (
    <Table>
      <thead><tr><Th>Market</Th><Th>Side</Th><Th className="text-right">Size</Th><Th className="text-right">Entry</Th><Th className="text-right">{onClose ? "Mark" : "Exit"}</Th>
        <Th className="text-right">Liq. price</Th><Th className="text-right">Margin</Th><Th className="text-right">P&amp;L</Th><Th>{onClose ? "" : "Status"}</Th></tr></thead>
      <tbody>
        {rows.map((p) => {
          const pnl = n(onClose ? p.unrealised_pnl : p.realised_pnl);
          return (
            <Tr key={p.id} data-testid={onClose ? "futures-open-row" : "futures-closed-row"}>
              <Td className="font-medium">{p.symbol}<div className="text-[11px] text-subtle">{formatDateTime(p.opened_at)}</div></Td>
              <Td><Badge tone={p.side === "LONG" ? "positive" : "negative"}>{p.side} {p.leverage}x</Badge>
                {p.source === "bot" && <div className="mt-1 text-[11px] text-accent" title="Opened by the AI futures bot">AI bot{onClose && p.stop_price != null ? ` · stop ${formatPrice(p.stop_price, p.price_decimals)}` : ""}{onClose && p.exit_due_at ? ` · exits ${formatDateTime(p.exit_due_at)}` : ""}</div>}</Td>
              <Td className="num text-right">{Number(p.quantity).toFixed(6)}</Td>
              <Td className="num text-right">{formatPrice(p.entry_price, p.price_decimals)}</Td>
              <Td className="num text-right">{formatPrice(onClose ? p.mark_price : p.exit_price, p.price_decimals)}</Td>
              <Td className="num text-right text-warning">{formatPrice(p.liquidation_price, p.price_decimals)}
                {onClose && p.distance_to_liquidation_pct != null && <div className="text-[11px] text-subtle">{p.distance_to_liquidation_pct.toFixed(1)}% away</div>}</Td>
              <Td className="num text-right">{formatMoney(Number(p.margin), ccy)}{Number(p.funding) !== 0 && <div className="text-[11px] text-subtle">funding {formatMoney(Number(p.funding), ccy)}</div>}</Td>
              <Td className={cn("num text-right", pnl == null ? "" : pnl > 0 ? "text-positive" : pnl < 0 ? "text-negative" : "")}>
                {pnl == null ? "—" : formatMoney(pnl, ccy)}{onClose && p.roe_pct != null && <div className="text-[11px]">{p.roe_pct >= 0 ? "+" : ""}{p.roe_pct.toFixed(1)}% ROE</div>}
              </Td>
              <Td>{onClose ? <Button size="sm" variant="secondary" disabled={closing === p.id} onClick={() => onClose(p.id)}>Close</Button>
                : <Badge tone={STATUS_TONE[p.status]}>{p.status === "LIQUIDATED" ? "Liquidated" : p.exit_reason === "stop" ? "Stop-loss" : p.exit_reason === "time" ? "Time exit" : "Closed"}</Badge>}</Td>
            </Tr>
          );
        })}
      </tbody>
    </Table>
  );
}

export function FuturesPage() {
  const { account, list, select } = useAccountParam();
  const cfg = useFuturesConfig();
  const overview = useMarketOverview();
  const portfolio = usePortfolio(account?.id);
  const [symbol, setSymbol] = useState("BTC-USD");
  const [side, setSide] = useState<FuturesSide>("LONG");
  const [leverage, setLeverage] = useState(3);
  const [margin, setMargin] = useState("5.00");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const open = useOpenFutures();
  const close = useCloseFutures();
  const positions = useFuturesPositions(account?.id);
  const preview = useFuturesPreview({ account_id: account?.id, symbol, side, margin, leverage });
  const crypto_ = useMemo(() => (overview.data?.groups.CRYPTO ?? []).map((r) => r.instrument), [overview.data]);
  const decimals = crypto_.find((i) => i.symbol === symbol)?.price_decimals ?? 2;
  const ccy = account?.base_currency ?? "GBP";
  const maxLev = cfg.data?.max_leverage ?? 10;
  const rows = positions.data ?? [];
  const openRows = rows.filter((p) => p.status === "OPEN"), closedRows = rows.filter((p) => p.status !== "OPEN");
  const upnl = n(openRows.reduce((t, p) => t + Number(p.unrealised_pnl ?? 0), 0)) ?? 0, used = openRows.reduce((t, p) => t + Number(p.margin), 0);
  const realised = closedRows.reduce((t, p) => t + (n(p.realised_pnl) ?? 0), 0);
  const pv = preview.data;
  const checks = open.error instanceof ApiError ? (open.error.details as { checks?: RiskCheck[] } | undefined)?.checks : undefined;
  const equity = Number(portfolio.data?.equity ?? 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!account) return;
    try { await open.mutateAsync({ account_id: account.id, symbol, side, margin, leverage, client_id: key.replace(/-/g, "").slice(0, 32) }); }
    catch { /* shown through open.error, with the risk checks */ } finally { setKey(crypto.randomUUID()); }
  }

  if (list.length === 0) return <EmptyState title="No paper account">Create a paper account first (a £100 preset is available).</EmptyState>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-xl font-semibold tracking-tight">Futures</h1>
          <p className="text-sm text-muted">Crypto perpetuals with leverage, isolated margin, a real order book, liquidation and funding, simulated with virtual money.</p></div>
        {list.length > 1 && (
          <Select aria-label="Account" className="h-9 w-56" value={account?.id} onChange={(e) => select(e.target.value)}>
            {list.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.base_currency}</option>)}
          </Select>)}
      </div>
      <Disclaimer notice={cfg.data?.notice} />
      {account && <FuturesBotPanel accountId={account.id} currency={ccy} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Equity" value={formatMoney(equity, ccy)} sub="including futures margin and open P&L" />
        <Stat label="Margin in use" value={formatMoney(used, ccy)} sub={`${openRows.length} open position${openRows.length === 1 ? "" : "s"}`} />
        <Stat label="Unrealised P&L" value={formatMoney(upnl, ccy)} tone={upnl > 0 ? "positive" : upnl < 0 ? "negative" : undefined} />
        <Stat label="Realised P&L" value={formatMoney(realised, ccy)} tone={realised > 0 ? "positive" : realised < 0 ? "negative" : undefined}
          sub={cfg.data ? `next funding ${formatDateTime(cfg.data.next_funding_at)}` : undefined} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,360px)_minmax(0,320px)_1fr]">
        <Card data-tour="futures-ticket">
          <CardHeader title="Open a position" description="Isolated margin: the most you can lose is the margin you put in" />
          <CardBody>
            <form onSubmit={submit} className="space-y-4" aria-label="Futures order">
              <Field label="Market" htmlFor="fut-symbol">
                <Select id="fut-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                  {(crypto_.length ? crypto_.map((i) => i.symbol) : ["BTC-USD", "ETH-USD"]).map((x) => <option key={x}>{x}</option>)}
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-2" role="group" aria-label="Side">
                <Button type="button" variant={side === "LONG" ? "primary" : "secondary"} aria-pressed={side === "LONG"}
                  className={cn(side === "LONG" && "bg-positive hover:bg-positive/90")} onClick={() => setSide("LONG")}><ArrowUp />Long</Button>
                <Button type="button" variant={side === "SHORT" ? "primary" : "secondary"} aria-pressed={side === "SHORT"}
                  className={cn(side === "SHORT" && "bg-negative hover:bg-negative/90")} onClick={() => setSide("SHORT")}><ArrowDown />Short</Button>
              </div>
              <Field label={`Leverage: ${leverage}x`} htmlFor="fut-lev" hint={`1x to ${maxLev}x. Higher leverage puts liquidation closer.`}>
                <input id="fut-lev" type="range" min={1} max={maxLev} step={1} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" />
              </Field>
              <Field label={`Margin (${ccy})`} htmlFor="fut-margin" hint={equity ? `${((Number(margin) / equity) * 100).toFixed(1)}% of equity (max ${cfg.data?.max_margin_pct ?? 20}%)` : undefined}>
                <Input id="fut-margin" inputMode="decimal" required pattern="^\d+(\.\d{1,2})?$" className="num" value={margin} onChange={(e) => setMargin(e.target.value)} />
              </Field>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg border border-border bg-surface-2 p-3 text-xs" data-testid="futures-preview" data-tour="futures-preview">
                <dt className="text-subtle">Position size</dt><dd className="num text-right">{pv ? `${Number(pv.quantity).toFixed(6)} ${symbol.split("-")[0]}` : "—"}</dd>
                <dt className="text-subtle">Notional</dt><dd className="num text-right">{pv?.notional != null ? formatMoney(Number(pv.notional), "USD") : "—"}</dd>
                <dt className="text-subtle">Est. entry (book)</dt><dd className="num text-right">{formatPrice(pv?.avg_price ?? null, decimals)}</dd>
                <dt className="text-subtle">Slippage</dt><dd className="num text-right">{pv?.slippage_bps != null ? `${pv.slippage_bps.toFixed(2)} bps · ${pv.levels} level${pv.levels === 1 ? "" : "s"}` : "—"}</dd>
                <dt className="text-subtle">Taker fee</dt><dd className="num text-right">{pv?.fee != null ? formatMoney(Number(pv.fee), ccy) : "—"}</dd>
                <dt className="font-medium text-warning">Liquidation price</dt><dd className="num text-right font-medium text-warning" data-testid="futures-liq">{formatPrice(pv?.liquidation_price ?? null, decimals)}</dd>
              </dl>
              {pv && pv.avg_price == null && Number(pv.quantity) > 0 && <p className="text-xs text-negative">Not enough liquidity on the book for this size.</p>}
              {preview.error && <ErrorBanner error={preview.error} />}
              <Button type="submit" className="w-full" disabled={open.isPending || !account}>
                {open.isPending ? <Spinner /> : null}Open {side.toLowerCase()} {leverage}x
              </Button>
              {open.error && <ErrorBanner error={open.error} />}
              {checks && <ChecksList checks={checks} compact />}
              {open.isSuccess && !open.error && <p className="text-xs text-positive" role="status">Position opened.</p>}
            </form>
          </CardBody>
        </Card>
        <OrderBook symbol={symbol} decimals={decimals} />
        <SignalCard symbol={symbol} onUse={(s, l) => { setSide(s); setLeverage(Math.min(l, maxLev)); }} />
      </div>

      <Card data-tour="futures-positions">
        <CardHeader title="Open positions" description="Marked to the live mid price. The worker liquidates a position the moment the mark crosses its liquidation price." />
        {close.error && <div className="px-4"><ErrorBanner error={close.error} /></div>}
        {openRows.length ? <PositionRows rows={openRows} ccy={ccy} onClose={(id) => close.mutate(id)} closing={close.isPending ? close.variables : null} />
          : <CardBody><p className="text-sm text-muted">No open futures positions.</p></CardBody>}
      </Card>
      {closedRows.length > 0 && (
        <Card>
          <CardHeader title="History" description="Closed and liquidated positions" />
          <PositionRows rows={closedRows} ccy={ccy} />
        </Card>
      )}
    </div>
  );
}
