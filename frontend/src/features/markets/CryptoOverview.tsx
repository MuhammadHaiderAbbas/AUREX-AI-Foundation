import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/feedback";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { Instrument, Quote } from "@/services/api";

/**
 * Crypto market overview in the style of a trading terminal's markets page. Market-wide figures
 * (capitalisation, volume, dominance, 7-day sparklines) come from CoinGecko's public API; prices
 * for every coin we trade tick live from our own quote stream (Coinbase). Both APIs are public,
 * keyless and allow browser requests, so this works in the static demo and the full deployment.
 */
const CG = "https://api.coingecko.com/api/v3";

interface CgGlobal { data: { total_market_cap: { usd: number }; total_volume: { usd: number }; market_cap_percentage: Record<string, number>; market_cap_change_percentage_24h_usd: number; active_cryptocurrencies: number } }
interface CgCoin {
  id: string; symbol: string; name: string; image: string; current_price: number; market_cap: number; market_cap_rank: number; total_volume: number;
  price_change_percentage_1h_in_currency: number | null; price_change_percentage_24h_in_currency: number | null; price_change_percentage_7d_in_currency: number | null;
  sparkline_in_7d?: { price: number[] };
}

async function cg<T>(path: string): Promise<T> {
  const r = await fetch(CG + path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
  return r.json() as Promise<T>;
}

export const useCryptoGlobal = () => useQuery({ queryKey: ["coingecko", "global"], queryFn: () => cg<CgGlobal>("/global"), refetchInterval: 120_000, staleTime: 60_000, retry: 1 });
export const useCryptoMarkets = () => useQuery({
  queryKey: ["coingecko", "markets"], refetchInterval: 120_000, staleTime: 60_000, retry: 1,
  queryFn: () => cg<CgCoin[]>("/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=true&price_change_percentage=1h,24h,7d"),
});

// Stablecoins sit at $1 and never move: keep them in the table, not in the headline cards.
const STABLE = new Set(["usdt", "usdc", "dai", "usde", "usds", "fdusd", "tusd", "pyusd", "usdd", "busd", "usd1"]);
const big = (v: number) => (v >= 1e12 ? `${(v / 1e12).toFixed(2)} T` : v >= 1e9 ? `${(v / 1e9).toFixed(2)} B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)} M` : v.toLocaleString("en-US"));
const price = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: v >= 1 ? 2 : 4, maximumFractionDigits: v >= 1 ? 2 : 6 });

function Pct({ v, className }: { v: number | null | undefined; className?: string }) {
  if (v == null || !Number.isFinite(v)) return <span className={cn("num text-subtle", className)}>—</span>;
  return <span className={cn("num", v > 0 ? "text-positive" : v < 0 ? "text-negative" : "text-muted", className)}>{v > 0 ? "+" : ""}{v.toFixed(2)}%</span>;
}

export function Sparkline({ values, up, width = 96, height = 28 }: { values: number[]; up: boolean; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const step = Math.max(1, Math.floor(values.length / 60));
  const pts = values.filter((_, i) => i % step === 0 || i === values.length - 1);
  const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1;
  const d = pts.map((v, i) => `${(i / (pts.length - 1)) * width},${height - 2 - ((v - lo) / span) * (height - 4)}`).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="shrink-0">
      <polyline fill="none" strokeWidth="1.5" stroke={up ? "var(--color-positive)" : "var(--color-negative)"} points={d} />
    </svg>
  );
}

export function CryptoOverview({ instruments, quotes, onSelect, part }: {
  instruments: Instrument[]; quotes: Record<string, Quote | null | undefined>; onSelect: (slug: string) => void; part: "cards" | "details";
}) {
  const global = useCryptoGlobal();
  const markets = useCryptoMarkets();
  const bySymbol = new Map(instruments.filter((i) => i.asset_class === "CRYPTO").map((i) => [i.base_currency.toUpperCase(), i]));
  const livePrice = (c: CgCoin) => {
    const inst = bySymbol.get(c.symbol.toUpperCase());
    const q = inst ? quotes[inst.symbol] : null;
    return q ? { price: Number(q.last), change: q.change_pct == null ? c.price_change_percentage_24h_in_currency : Number(q.change_pct), inst, live: true }
      : { price: c.current_price, change: c.price_change_percentage_24h_in_currency, inst, live: false };
  };
  const coins = markets.data ?? [];
  const g = global.data?.data;
  const dom = g?.market_cap_percentage ?? {};
  const btcD = dom.btc ?? 0, ethD = dom.eth ?? 0;

  if (part === "cards") return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" data-testid="ticker-cards">
        {coins.filter((c) => !STABLE.has(c.symbol.toLowerCase())).slice(0, 6).map((c) => {
          const lp = livePrice(c);
          const up = (lp.change ?? 0) >= 0;
          return (
            <button key={c.id} type="button" onClick={() => lp.inst && onSelect(lp.inst.slug)} disabled={!lp.inst}
              className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3 text-left hover:border-border-strong disabled:cursor-default">
              <img src={c.image} alt="" className="size-8 rounded-full" loading="lazy" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{c.name}</div>
                <div className="num text-sm">{price(lp.price)} <span className="text-[10px] text-subtle">USD</span></div>
                <Pct v={lp.change} className="text-xs" />
              </div>
              <Sparkline values={c.sparkline_in_7d?.price ?? []} up={up} width={56} height={30} />
            </button>
          );
        })}
        {!coins.length && (markets.isLoading ? <div className="col-span-full flex h-20 items-center justify-center"><Spinner /></div>
          : <p className="col-span-full text-xs text-subtle">Market-wide data is unavailable right now (CoinGecko rate limit or network). Prices below still stream live.</p>)}
      </div>
  );

  return (
    <div className="space-y-4" data-testid="crypto-overview">
      {g && (
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-border bg-surface p-4">
            <div className="text-xs font-medium uppercase tracking-wider text-muted">Crypto total market cap</div>
            <div className="num mt-1 text-2xl font-semibold">{big(g.total_market_cap.usd)} <span className="text-xs text-subtle">USD</span></div>
            <Pct v={g.market_cap_change_percentage_24h_usd} className="text-sm" /> <span className="text-xs text-subtle">24h</span>
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <div className="text-xs font-medium uppercase tracking-wider text-muted">24h volume</div>
            <div className="num mt-1 text-2xl font-semibold">{big(g.total_volume.usd)} <span className="text-xs text-subtle">USD</span></div>
            <div className="text-xs text-subtle">{g.active_cryptocurrencies.toLocaleString("en-US")} active coins</div>
          </div>
          <div className="rounded-lg border border-border bg-surface p-4" data-testid="dominance">
            <div className="text-xs font-medium uppercase tracking-wider text-muted">Dominance</div>
            <div className="mt-2 flex justify-between text-xs"><span>Bitcoin <b className="num">{btcD.toFixed(2)}%</b></span><span>Ethereum <b className="num">{ethD.toFixed(2)}%</b></span><span>Others <b className="num">{(100 - btcD - ethD).toFixed(2)}%</b></span></div>
            <div className="mt-2 flex h-2 overflow-hidden rounded-full">
              <div className="bg-info" style={{ width: `${btcD}%` }} /><div className="bg-positive" style={{ width: `${ethD}%` }} /><div className="flex-1 bg-negative" />
            </div>
          </div>
        </div>
      )}

      {coins.length > 0 && (
        <Card>
          <CardHeader title="Top 20 by market cap" description="Prices for coins you can trade here stream live; market cap, volume and 7-day lines from CoinGecko" />
          <div className="overflow-x-auto">
            <Table>
              <thead><tr><Th>#</Th><Th>Coin</Th><Th className="text-right">Price</Th><Th className="text-right">1h</Th><Th className="text-right">24h</Th><Th className="text-right">7d</Th>
                <Th className="text-right">Market cap</Th><Th className="text-right">Volume 24h</Th><Th className="text-right">Last 7 days</Th></tr></thead>
              <tbody data-testid="top-coins">
                {coins.map((c) => {
                  const lp = livePrice(c);
                  return (
                    <Tr key={c.id} className={cn(lp.inst && "cursor-pointer")} onClick={() => lp.inst && onSelect(lp.inst.slug)}>
                      <Td className="num text-xs text-subtle">{c.market_cap_rank}</Td>
                      <Td><div className="flex items-center gap-2"><img src={c.image} alt="" className="size-5 rounded-full" loading="lazy" />
                        <span className="font-medium">{c.name}</span><span className="text-xs uppercase text-subtle">{c.symbol}</span>
                        {lp.inst && <Badge tone={lp.live ? "positive" : "accent"}>{lp.live ? "Live · tradable" : "Tradable"}</Badge>}</div></Td>
                      <Td className="num text-right">{price(lp.price)}</Td>
                      <Td className="text-right"><Pct v={c.price_change_percentage_1h_in_currency} /></Td>
                      <Td className="text-right"><Pct v={lp.change} /></Td>
                      <Td className="text-right"><Pct v={c.price_change_percentage_7d_in_currency} /></Td>
                      <Td className="num text-right">{big(c.market_cap)}</Td>
                      <Td className="num text-right">{big(c.total_volume)}</Td>
                      <Td className="text-right"><div className="flex justify-end">
                        {(c.price_change_percentage_7d_in_currency ?? 0) >= 0 ? <ArrowUpRight className="sr-only" /> : <ArrowDownRight className="sr-only" />}
                        <Sparkline values={c.sparkline_in_7d?.price ?? []} up={(c.price_change_percentage_7d_in_currency ?? 0) >= 0} /></div></Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
          <p className="px-4 py-2 text-[11px] text-subtle">Market data: CoinGecko (public API) and Coinbase Exchange. Not investment advice.</p>
        </Card>
      )}
    </div>
  );
}
