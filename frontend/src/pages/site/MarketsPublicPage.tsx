import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { PageHero, Pct, big, usd } from "@/components/site/widgets";
import { useAuth } from "@/features/auth/AuthProvider";
import { Sparkline } from "@/features/markets/CryptoOverview";
import { useCryptoGlobal, useCryptoMarkets, usePublicFx } from "@/features/site/publicMarkets";
import { app } from "@/lib/paths";
import { cn } from "@/lib/utils";

const TRADABLE = new Set(["btc", "eth", "sol", "xrp", "doge", "ada", "avax", "link", "ltc", "dot", "bch", "paxg"]);

function TradeLink({ slug }: { slug: string }) {
  const { status } = useAuth();
  return (
    <Link to={status === "authenticated" ? app(`/trade?symbol=${slug}`) : "/register"} className="text-sm font-medium text-accent hover:underline">Trade</Link>
  );
}

export function MarketsTable({ limit = 50 }: { limit?: number }) {
  const [tab, setTab] = useState<"crypto" | "fx">("crypto");
  const crypto = useCryptoMarkets();
  const fx = usePublicFx();
  const coins = (crypto.data ?? []).slice(0, limit);
  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-surface" data-testid="public-markets">
      <div className="flex gap-1 border-b border-border px-3 pt-3" role="tablist">
        {([["crypto", "Crypto"], ["fx", "Forex"]] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cn("border-b-2 px-3 pb-2.5 text-sm font-medium", tab === k ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")}>{l}</button>
        ))}
      </div>
      <div className="overflow-x-auto">
        {tab === "crypto" ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-subtle">
              <tr><th className="px-4 py-3 font-medium">#</th><th className="px-4 py-3 font-medium">Name</th><th className="px-4 py-3 text-right font-medium">Price</th>
                <th className="px-4 py-3 text-right font-medium">24h</th><th className="hidden px-4 py-3 text-right font-medium md:table-cell">Market cap</th>
                <th className="hidden px-4 py-3 text-right font-medium lg:table-cell">Volume 24h</th><th className="hidden px-4 py-3 text-right font-medium sm:table-cell">Last 7 days</th><th className="px-4 py-3" /></tr>
            </thead>
            <tbody>
              {coins.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-muted">{crypto.isLoading ? "Loading live prices…" : "Live prices are unavailable right now. Please try again shortly."}</td></tr>
              )}
              {coins.map((c) => {
                const ch = c.price_change_percentage_24h_in_currency;
                const sym = c.symbol.toLowerCase();
                return (
                  <tr key={c.id} className="border-t border-border/60 hover:bg-surface-2">
                    <td className="num px-4 py-3 text-subtle">{c.market_cap_rank}</td>
                    <td className="px-4 py-3"><div className="flex items-center gap-3">{c.image ? <img src={c.image} alt="" className="size-6 rounded-full" loading="lazy" /> : <span className="size-6 rounded-full flex shrink-0 items-center justify-center bg-surface-3 text-[10px] font-semibold uppercase">{c.symbol.slice(0, 3)}</span>}
                      <span className="font-medium">{c.name}</span><span className="text-xs uppercase text-subtle">{c.symbol}</span></div></td>
                    <td className="num px-4 py-3 text-right">{usd(c.current_price)}</td>
                    <td className="px-4 py-3 text-right"><Pct v={ch} /></td>
                    <td className="num hidden px-4 py-3 text-right text-muted md:table-cell">{c.market_cap ? big(c.market_cap) : "—"}</td>
                    <td className="num hidden px-4 py-3 text-right text-muted lg:table-cell">{big(c.total_volume)}</td>
                    <td className="hidden px-4 py-3 sm:table-cell"><div className="flex justify-end"><Sparkline values={c.sparkline_in_7d?.price ?? []} up={(c.price_change_percentage_7d_in_currency ?? 0) >= 0} /></div></td>
                    <td className="px-4 py-3 text-right">{TRADABLE.has(sym) ? <TradeLink slug={`${sym.toUpperCase()}-USD`} /> : <span className="text-xs text-subtle">Watch only</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-subtle"><tr><th className="px-4 py-3 font-medium">Pair</th><th className="px-4 py-3 text-right font-medium">Rate</th><th className="px-4 py-3" /></tr></thead>
            <tbody>
              {(fx.data ?? []).map((p) => (
                <tr key={p.symbol} className="border-t border-border/60 hover:bg-surface-2">
                  <td className="px-4 py-3"><div className="font-medium">{p.symbol}</div><div className="text-xs text-subtle">{p.name}</div></td>
                  <td className="num px-4 py-3 text-right">{p.price.toFixed(p.symbol.includes("JPY") ? 3 : 5)}</td>
                  <td className="px-4 py-3 text-right">{["EUR/USD", "GBP/USD", "USD/JPY"].includes(p.symbol) ? <TradeLink slug={p.symbol.replace("/", "")} /> : <span className="text-xs text-subtle">Watch only</span>}</td>
                </tr>
              ))}
              {!fx.data?.length && <tr><td colSpan={3} className="px-4 py-10 text-center text-muted">{fx.isLoading ? "Loading live rates…" : "Rates are unavailable right now."}</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      <p className="border-t border-border px-4 py-2.5 text-[11px] text-subtle">Prices: CoinGecko (or Coinbase when CoinGecko is busy) and Coinbase exchange rates, refreshed about every minute. Not investment advice.</p>
    </div>
  );
}

export function MarketsPublicPage() {
  const g = useCryptoGlobal().data?.data;
  return (
    <>
      <PageHero eyebrow="Markets" title="Today's crypto and forex markets" intro="Live prices for the largest crypto assets and major currency pairs. Create an account to chart, analyse and trade them on paper.">
        {g && (
          <div className="mt-8 grid max-w-3xl gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-surface p-4"><div className="text-xs text-muted">Crypto market cap</div><div className="num mt-1 text-xl font-semibold">{big(g.total_market_cap.usd)}</div><Pct v={g.market_cap_change_percentage_24h_usd} className="text-xs" /></div>
            <div className="rounded-xl border border-border bg-surface p-4"><div className="text-xs text-muted">24h volume</div><div className="num mt-1 text-xl font-semibold">{big(g.total_volume.usd)}</div></div>
            <div className="rounded-xl border border-border bg-surface p-4"><div className="text-xs text-muted">Bitcoin dominance</div><div className="num mt-1 text-xl font-semibold">{(g.market_cap_percentage.btc ?? 0).toFixed(1)}%</div></div>
          </div>
        )}
      </PageHero>
      <div className="mx-auto max-w-7xl px-4 py-12 lg:px-6">
        <MarketsTable />
        <div className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-surface p-6">
          <div><h3 className="font-semibold">Want the AI's view on any of these?</h3><p className="text-sm text-muted">The desk analyses a market in seconds and explains every vote.</p></div>
          <Link to="/register"><Button>Get started <ArrowRight /></Button></Link>
        </div>
      </div>
    </>
  );
}
