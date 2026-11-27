import { Bot, Radio, Search, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PriceChart } from "@/charts/PriceChart";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/form";
import { useAccounts } from "@/features/accounts/hooks";
import { useCandles, useLiveQuotes, useMarketOverview, useWatchlist, useWatchlistToggle } from "@/features/markets/hooks";
import { OrderTicket } from "@/features/trading/OrderTicket";
import { useOrders, usePortfolio } from "@/features/trading/hooks";
import { app } from "@/lib/paths";
import { cn, formatDateTime, formatMoney, formatPct, formatPrice } from "@/lib/utils";
import type { AssetClass, Instrument, MarketStatus, Quote } from "@/services/api";

const TABS: { key: "WATCH" | AssetClass; label: string }[] = [
  { key: "WATCH", label: "Watchlist" }, { key: "CRYPTO", label: "Crypto" }, { key: "FX", label: "Forex" },
  { key: "STOCK", label: "Stocks" }, { key: "ETF", label: "ETFs" },
];
const TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"];
const INDICATORS = [
  { key: "sma20", label: "SMA 20" }, { key: "sma50", label: "SMA 50" }, { key: "ema20", label: "EMA 20" },
  { key: "bb20", label: "Bollinger" }, { key: "rsi14", label: "RSI 14" }, { key: "macd", label: "MACD" },
];
const SOURCE_LABEL: Record<string, string> = { synthetic: "Synthetic", coinbase: "Coinbase", coinbase_rates: "Coinbase rates", ecb_reference: "ECB reference", alpaca: "Alpaca" };

export function SourceBadge({ source }: { source: string | null | undefined }) {
  if (!source) return null;
  return <Badge tone={source === "synthetic" ? "warning" : "info"} title={source === "synthetic" ? "Simulated prices: not real market data" : undefined}>{SOURCE_LABEL[source] ?? source}</Badge>;
}

export function QuoteState({ q }: { q: Quote | undefined | null }) {
  if (!q) return <span className="text-xs text-subtle">No data</span>;
  if (!q.market_open) return <span className="flex items-center gap-1.5 text-xs text-subtle"><StatusDot />Closed</span>;
  if (q.stale) return <span className="flex items-center gap-1.5 text-xs text-warning" title={`Last update ${q.age_seconds}s ago`}><StatusDot tone="warning" />Stale</span>;
  return <span className="flex items-center gap-1.5 text-xs text-positive"><StatusDot tone="positive" />Open</span>;
}

export function Change({ q }: { q: Quote | undefined | null }) {
  const n = q?.change_pct == null ? 0 : Number(q.change_pct);
  return <span className={cn("num", n > 0 && "text-positive", n < 0 && "text-negative", n === 0 && "text-muted")}>{formatPct(q?.change_pct)}</span>;
}

const panel = "rounded-xl border border-border/70 bg-surface";
const WORKING: string[] = ["OPEN"];

function SessionList({ markets }: { markets: MarketStatus[] }) {
  return (
    <ul className="space-y-1.5 text-xs">
      {markets.map((m) => (
        <li key={m.market} className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2"><StatusDot tone={m.is_open ? "positive" : "neutral"} />{m.label}</span>
          <span className="text-subtle">{m.next_change ? `${m.is_open ? "closes" : "opens"} ${formatDateTime(m.next_change)}` : "always open"}</span>
        </li>
      ))}
    </ul>
  );
}

/** Positions and working orders of the selected account, under the chart. */
function AccountPanel({ accountId, onTrade }: { accountId: string | undefined; onTrade: (symbol: string, side: "BUY" | "SELL", qty?: string) => void }) {
  const [tab, setTab] = useState<"positions" | "orders">("positions");
  const pf = usePortfolio(accountId);
  const orders = useOrders(accountId);
  const positions = pf.data?.positions ?? [];
  const working = (orders.data?.items ?? []).filter((o) => WORKING.includes(o.status));
  return (
    <div className={panel} data-testid="terminal-account">
      <div className="flex items-center gap-1 border-b border-border px-3 pt-2" role="tablist">
        {([["positions", `Positions (${positions.length})`], ["orders", `Open orders (${working.length})`]] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cn("border-b-2 px-3 pb-2 text-xs font-medium", tab === k ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")}>{l}</button>
        ))}
        <Link to={app(tab === "positions" ? "/portfolio" : "/history")} className="ml-auto pb-2 text-xs text-muted hover:text-fg">Open {tab === "positions" ? "portfolio" : "history"} →</Link>
      </div>
      <div className="max-h-56 overflow-auto">
        {tab === "positions" ? (positions.length === 0 ? <p className="px-4 py-6 text-center text-xs text-subtle">No open positions on this account.</p> : (
          <table className="w-full text-xs">
            <thead className="text-left text-subtle"><tr><th className="px-4 py-2 font-medium">Symbol</th><th className="px-4 py-2 text-right font-medium">Qty</th><th className="px-4 py-2 text-right font-medium">Avg</th><th className="px-4 py-2 text-right font-medium">Last</th><th className="px-4 py-2 text-right font-medium">P&L</th><th /></tr></thead>
            <tbody>
              {positions.map((p) => {
                const pnl = Number(p.unrealised_pnl);
                return (
                  <tr key={p.id} className="border-t border-border/60">
                    <td className="px-4 py-2 font-medium">{p.symbol}</td><td className="num px-4 py-2 text-right">{p.quantity}</td>
                    <td className="num px-4 py-2 text-right">{formatPrice(p.avg_price, p.price_decimals)}</td><td className="num px-4 py-2 text-right">{formatPrice(p.last, p.price_decimals)}</td>
                    <td className={cn("num px-4 py-2 text-right", pnl > 0 ? "text-positive" : pnl < 0 ? "text-negative" : "")}>{formatMoney(p.unrealised_pnl, pf.data?.currency)}</td>
                    <td className="px-4 py-2 text-right"><button className="text-accent hover:underline" onClick={() => onTrade(p.symbol, "SELL", p.quantity)}>Close</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )) : (working.length === 0 ? <p className="px-4 py-6 text-center text-xs text-subtle">No working orders.</p> : (
          <table className="w-full text-xs">
            <thead className="text-left text-subtle"><tr><th className="px-4 py-2 font-medium">Symbol</th><th className="px-4 py-2 font-medium">Side</th><th className="px-4 py-2 font-medium">Type</th><th className="px-4 py-2 text-right font-medium">Qty</th><th className="px-4 py-2 text-right font-medium">Price</th><th className="px-4 py-2 font-medium">Status</th></tr></thead>
            <tbody>
              {working.map((o) => (
                <tr key={o.id} className="border-t border-border/60">
                  <td className="px-4 py-2 font-medium">{o.symbol}</td><td className={o.side === "BUY" ? "px-4 py-2 text-positive" : "px-4 py-2 text-negative"}>{o.side}</td>
                  <td className="px-4 py-2">{o.type}</td><td className="num px-4 py-2 text-right">{o.quantity}</td>
                  <td className="num px-4 py-2 text-right">{o.limit_price ?? o.stop_price ?? "—"}</td><td className="px-4 py-2 text-muted">{o.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </div>
  );
}

export function MarketsPage() {
  const overview = useMarketOverview();
  const watchlist = useWatchlist();
  const toggle = useWatchlistToggle();
  const accounts = useAccounts();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("WATCH");
  const [search, setSearch] = useState("");
  const [timeframe, setTimeframe] = useState("1h");
  const [indicators, setIndicators] = useState<string[]>(["sma20", "rsi14"]);
  const [ticket, setTicket] = useState<{ symbol: string; side: "BUY" | "SELL"; qty?: string } | null>(null);
  const [accountId, setAccountId] = useState<string>("");
  const account = accountId || accounts.data?.[0]?.id;
  const pf = usePortfolio(account);

  const all = useMemo(() => Object.values(overview.data?.groups ?? {}).flat(), [overview.data]);
  const watched = new Set(watchlist.data?.items.map((i) => i.instrument.symbol));
  const rows = (tab === "WATCH" ? watchlist.data?.items ?? [] : overview.data?.groups[tab] ?? [])
    .filter((r) => !search || `${r.instrument.symbol} ${r.instrument.display_name}`.toLowerCase().includes(search.toLowerCase()));

  const { quotes: liveQuotes, live } = useLiveQuotes(all.map((r) => r.instrument.symbol));
  const quoteOf = (r: { instrument: Instrument; quote: Quote | null }) => liveQuotes[r.instrument.symbol] ?? r.quote;

  const selectedSlug = params.get("symbol") ?? "BTC-USD";
  const selected = all.find((r) => r.instrument.slug === selectedSlug) ?? all[0];
  const candles = useCandles(selected?.instrument.slug, timeframe, indicators);
  const sq = selected ? quoteOf(selected) : null;
  const liveTick = useMemo(() => (sq && sq.market_open ? { price: Number(sq.last), at: sq.as_of } : null), [sq?.last, sq?.as_of, sq?.market_open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (overview.isLoading) return <Spinner className="mx-auto mt-16" />;
  const inst = selected?.instrument;
  const d = inst?.price_decimals ?? 2;
  return (
    <div className="space-y-2" data-testid="trade-terminal">
      <ErrorBanner error={overview.error ?? candles.error ?? toggle.error} />

      {/* Symbol bar */}
      {inst && (
        <div className={cn(panel, "flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3")}>
          <div className="flex items-center gap-3">
            <button aria-label={watched.has(inst.symbol) ? `Remove ${inst.symbol} from watchlist` : `Add ${inst.symbol} to watchlist`}
              onClick={() => toggle.mutate({ slug: inst.slug, on: !watched.has(inst.symbol) })} className={watched.has(inst.symbol) ? "text-warning" : "text-subtle hover:text-muted"}>
              <Star className={cn("size-4", watched.has(inst.symbol) && "fill-current")} />
            </button>
            <div>
              <div className="flex items-center gap-2"><span className="text-lg font-semibold">{inst.symbol}</span><SourceBadge source={sq?.source} /></div>
              <div className="text-xs text-subtle">{inst.display_name} · {inst.venue}</div>
            </div>
          </div>
          <div>
            <div className="num text-2xl font-semibold tracking-tight" data-testid="last-price">{formatPrice(sq?.last, d)}</div>
            <div className="text-xs"><Change q={sq} /> <span className="text-subtle">vs prev close</span></div>
          </div>
          <dl className="grid grid-cols-3 gap-x-6 text-xs">
            <div><dt className="text-subtle">Bid</dt><dd className="num text-positive">{formatPrice(sq?.bid, d)}</dd></div>
            <div><dt className="text-subtle">Ask</dt><dd className="num text-negative">{formatPrice(sq?.ask, d)}</dd></div>
            <div><dt className="text-subtle">Updated</dt><dd className="num">{sq ? formatDateTime(sq.as_of) : "—"}</dd></div>
          </dl>
          <div className="ml-auto flex items-center gap-3 text-xs text-muted">
            <QuoteState q={sq} />
            <span className="flex items-center gap-1.5"><Radio className={cn("size-3.5", live ? "text-positive" : "text-subtle")} />{live ? "Streaming" : "Polling"}</span>
            {overview.data?.data_mode === "synthetic" && <Badge tone="warning" title="Prices are generated deterministically for development. They are not real market data.">Synthetic data</Badge>}
            {overview.data?.data_mode === "mixed" && <Badge tone="info" title="Crypto streams live from Coinbase and forex rates refresh about once a minute. Stocks and ETFs need a keyed real-time data vendor, so they are simulated here.">Crypto &amp; FX live · stocks simulated</Badge>}
          </div>
        </div>
      )}

      <div className="grid gap-2 xl:grid-cols-[300px_minmax(0,1fr)_300px]">
        {/* Watchlist */}
        <div className={cn(panel, "flex min-w-0 flex-col xl:max-h-[calc(100vh-190px)]")}>
          <div className="flex gap-1 overflow-x-auto border-b border-border px-2 pt-2" role="tablist">
            {TABS.map((t) => (
              <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
                className={cn("whitespace-nowrap border-b-2 px-2.5 pb-2 text-xs font-medium", tab === t.key ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")}>{t.label}</button>
            ))}
          </div>
          <div className="relative p-2">
            <Search className="pointer-events-none absolute top-1/2 left-5 size-3.5 -translate-y-1/2 text-subtle" />
            <Input aria-label="Search instruments" placeholder="Search" className="h-8 pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {rows.length === 0 ? <EmptyState title={tab === "WATCH" ? "Watchlist is empty" : "No instruments"} /> : (
            <ul className="max-h-[420px] flex-1 overflow-y-auto xl:max-h-none">
              {rows.map((r) => {
                const q = quoteOf(r);
                const active = r.instrument.slug === inst?.slug;
                const on = watched.has(r.instrument.symbol);
                return (
                  <li key={r.instrument.symbol}>
                    <div className={cn("flex items-center gap-2 px-3 py-2", active ? "bg-accent/10" : "hover:bg-surface-2")}>
                      <button aria-label={on ? `Remove ${r.instrument.symbol} from watchlist` : `Add ${r.instrument.symbol} to watchlist`}
                        onClick={() => toggle.mutate({ slug: r.instrument.slug, on: !on })} className={cn("shrink-0", on ? "text-warning" : "text-subtle hover:text-muted")}>
                        <Star className={cn("size-3.5", on && "fill-current")} />
                      </button>
                      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setParams({ symbol: r.instrument.slug })}>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium">{r.instrument.symbol}</div>
                          <div className="truncate text-[11px] text-subtle">{r.instrument.display_name}</div>
                        </div>
                        <div className="text-right">
                          <div className="num text-sm">{formatPrice(q?.last, r.instrument.price_decimals)}</div>
                          <div className="text-[11px]"><Change q={q} /></div>
                        </div>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Chart */}
        <div className="min-w-0 space-y-2">
          <div className={panel}>
            <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
              <div className="flex rounded-lg bg-surface-2 p-0.5" role="group" aria-label="Timeframe">
                {TIMEFRAMES.map((tf) => (
                  <button key={tf} aria-pressed={timeframe === tf} onClick={() => setTimeframe(tf)}
                    className={cn("num rounded-md px-2.5 py-1 text-xs", timeframe === tf ? "bg-surface-3 text-fg" : "text-muted hover:text-fg")}>{tf}</button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Indicators">
                {INDICATORS.map((i) => {
                  const on = indicators.includes(i.key);
                  return (
                    <button key={i.key} aria-pressed={on} onClick={() => setIndicators(on ? indicators.filter((x) => x !== i.key) : [...indicators, i.key])}
                      className={cn("rounded-md px-2 py-1 text-[11px]", on ? "bg-accent/15 text-accent" : "text-muted hover:bg-surface-2 hover:text-fg")}>{i.label}</button>
                  );
                })}
              </div>
              {candles.isFetching && <Spinner className="ml-auto" />}
            </div>
            <div className="p-1">
              {inst && candles.data && candles.data.candles.length > 0 ? (
                <PriceChart data={candles.data} decimals={d} live={liveTick} />
              ) : candles.isLoading ? <div className="flex h-[420px] items-center justify-center"><Spinner /></div> : <EmptyState title="No candles for this timeframe" />}
              <p className="px-3 py-1.5 text-[10px] text-subtle">
                {candles.data?.candles.length ?? 0} candles · source {SOURCE_LABEL[candles.data?.source ?? ""] ?? candles.data?.source ?? "—"} · charts by TradingView Lightweight Charts
              </p>
            </div>
          </div>
          <AccountPanel accountId={account} onTrade={(symbol, side, qty) => setTicket({ symbol, side, qty })} />
        </div>

        {/* Trade panel */}
        {inst && (
          <div className="space-y-2">
            <div className={cn(panel, "p-4")} data-testid="trade-panel">
              <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Trade {inst.symbol}</h2>
                {sq && !sq.tradable && <Badge tone="warning" title="Orders on closed markets or stale prices are rejected; limit and stop orders wait for the market.">Not tradable now</Badge>}</div>
              {(accounts.data?.length ?? 0) > 1 && (
                <Select aria-label="Trading account" className="mt-3 h-8 text-xs" value={account ?? ""} onChange={(e) => setAccountId(e.target.value)}>
                  {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.base_currency}</option>)}
                </Select>
              )}
              <dl className="mt-3 space-y-1.5 text-xs">
                <div className="flex justify-between"><dt className="text-subtle">Available cash</dt><dd className="num">{pf.data ? formatMoney(pf.data.available_cash, pf.data.currency) : "—"}</dd></div>
                <div className="flex justify-between"><dt className="text-subtle">Equity</dt><dd className="num">{pf.data ? formatMoney(pf.data.equity, pf.data.currency) : "—"}</dd></div>
              </dl>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button variant="buy" onClick={() => setTicket({ symbol: inst.symbol, side: "BUY" })}>Buy</Button>
                <Button variant="sell" onClick={() => setTicket({ symbol: inst.symbol, side: "SELL" })}>Sell</Button>
              </div>
              <p className="mt-3 text-[11px] text-subtle">Every order passes the independent risk gate. Paper money only.</p>
            </div>
            <Link to={app(`/ai?symbol=${encodeURIComponent(inst.symbol)}`)} className={cn(panel, "flex items-center gap-3 p-4 hover:border-accent/50")}>
              <span className="flex size-9 items-center justify-center rounded-lg bg-accent/15 text-accent"><Bot className="size-4" /></span>
              <span><span className="block text-sm font-medium">Ask the AI desk</span><span className="block text-xs text-subtle">Eight agents analyse {inst.symbol}</span></span>
            </Link>
            <div className={cn(panel, "p-4")}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-subtle">Market info</h3>
              <dl className="mt-3 space-y-1.5 text-xs">
                <div className="flex justify-between"><dt className="text-subtle">Type</dt><dd>{inst.instrument_type}</dd></div>
                <div className="flex justify-between"><dt className="text-subtle">Quote currency</dt><dd>{inst.quote_currency}</dd></div>
                <div className="flex justify-between"><dt className="text-subtle">Minimum size</dt><dd className="num">{inst.lot_size}</dd></div>
                <div className="flex justify-between"><dt className="text-subtle">Tick size</dt><dd className="num">{inst.tick_size}</dd></div>
              </dl>
              <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-subtle">Sessions</h3>
              <div className="mt-2"><SessionList markets={overview.data?.markets ?? []} /></div>
            </div>
          </div>
        )}
      </div>
      {ticket && <OrderTicket open onClose={() => setTicket(null)} symbol={ticket.symbol} side={ticket.side} quantity={ticket.qty} accountId={account} />}
    </div>
  );
}
