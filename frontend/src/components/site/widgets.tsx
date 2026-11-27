import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Sparkline } from "@/features/markets/CryptoOverview";
import { useCryptoMarkets } from "@/features/site/publicMarkets";
import { cn } from "@/lib/utils";

export const usd = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: v >= 1 ? 2 : 4, maximumFractionDigits: v >= 1 ? 2 : 6 });
export const big = (v: number) => (v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${v.toLocaleString("en-US")}`);
const STABLE = new Set(["usdt", "usdc", "dai", "usde", "usds", "fdusd", "tusd", "pyusd", "usdd", "busd", "usd1"]);

export function Pct({ v, className }: { v: number | null | undefined; className?: string }) {
  if (v == null || !Number.isFinite(v)) return <span className={cn("num text-subtle", className)}>—</span>;
  return <span className={cn("num", v > 0 ? "text-positive" : v < 0 ? "text-negative" : "text-muted", className)}>{v > 0 ? "+" : ""}{v.toFixed(2)}%</span>;
}

export function Section({ id, eyebrow, title, intro, children, className }: {
  id?: string; eyebrow?: string; title: ReactNode; intro?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section id={id} className={cn("mx-auto max-w-7xl px-4 py-16 lg:px-6 lg:py-20", className)}>
      <div className="max-w-2xl">
        {eyebrow && <p className="text-sm font-semibold text-accent">{eyebrow}</p>}
        <h2 className="mt-2 text-3xl font-semibold tracking-tight lg:text-4xl">{title}</h2>
        {intro && <p className="mt-3 text-lg text-muted">{intro}</p>}
      </div>
      <div className="mt-10">{children}</div>
    </section>
  );
}

/** Scrolling ticker tape of the largest coins (CoinGecko). */
export function TickerTape() {
  const m = useCryptoMarkets();
  const coins = (m.data ?? []).filter((c) => !STABLE.has(c.symbol.toLowerCase())).slice(0, 14);
  if (!coins.length) return <div className="h-10 border-y border-border bg-surface/50" />;
  const items = [...coins, ...coins];
  return (
    <div className="overflow-hidden border-y border-border bg-surface/50" aria-label="Live crypto prices" data-testid="ticker-tape">
      <div className="animate-marquee flex w-max">
        {items.map((c, i) => (
          <div key={`${c.id}-${i}`} className="flex items-center gap-2 px-5 py-2.5 text-sm" aria-hidden={i >= coins.length}>
            <span className="font-semibold uppercase">{c.symbol}</span>
            <span className="num text-muted">{usd(c.current_price)}</span>
            <Pct v={c.price_change_percentage_24h_in_currency} className="text-xs" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Compact live list for the hero card. */
export function HeroMarkets() {
  const m = useCryptoMarkets();
  const coins = (m.data ?? []).filter((c) => !STABLE.has(c.symbol.toLowerCase())).slice(0, 6);
  return (
    <div className="rounded-2xl border border-border bg-surface/90 p-2 shadow-2xl shadow-black/40" data-testid="hero-markets">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-sm font-semibold">Popular markets</span>
        <Link to="/markets" className="flex items-center gap-1 text-xs text-muted hover:text-fg">View all <ArrowRight className="size-3" /></Link>
      </div>
      <ul>
        {coins.length === 0 && Array.from({ length: 6 }, (_, i) => <li key={i} className="m-1 h-12 animate-pulse rounded-lg bg-surface-2" />)}
        {coins.map((c) => {
          const ch = c.price_change_percentage_24h_in_currency;
          return (
            <li key={c.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-2">
              {c.image ? <img src={c.image} alt="" className="size-7 rounded-full" loading="lazy" /> : <span className="size-7 rounded-full flex shrink-0 items-center justify-center bg-surface-3 text-[10px] font-semibold uppercase">{c.symbol.slice(0, 3)}</span>}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold uppercase">{c.symbol}</div>
                <div className="truncate text-xs text-subtle">{c.name}</div>
              </div>
              <Sparkline values={c.sparkline_in_7d?.price ?? []} up={(ch ?? 0) >= 0} width={64} height={24} />
              <div className="w-28 text-right">
                <div className="num text-sm">{usd(c.current_price)}</div>
                <Pct v={ch} className="text-xs" />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function FeatureCard({ icon, title, children, to }: { icon: ReactNode; title: string; children: ReactNode; to?: string }) {
  const body = (
    <div className="group h-full rounded-2xl border border-border/70 bg-surface p-6 transition-colors hover:border-accent/50">
      <div className="flex size-11 items-center justify-center rounded-xl bg-accent/10 text-accent [&_svg]:size-5">{icon}</div>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">{children}</p>
      {to && <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent">Learn more <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" /></span>}
    </div>
  );
  return to ? <Link to={to} className="block h-full">{body}</Link> : body;
}

export function Faq({ items }: { items: [string, ReactNode][] }) {
  return (
    <div className="divide-y divide-border rounded-2xl border border-border/70 bg-surface">
      {items.map(([q, a]) => (
        <details key={q} className="group px-6 py-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
            {q}<span className="text-xl leading-none text-muted transition-transform group-open:rotate-45">+</span>
          </summary>
          <div className="mt-3 text-sm leading-relaxed text-muted">{a}</div>
        </details>
      ))}
    </div>
  );
}

export function PageHero({ eyebrow, title, intro, children }: { eyebrow?: string; title: ReactNode; intro?: ReactNode; children?: ReactNode }) {
  return (
    <div className="bg-grid border-b border-border">
      <div className="mx-auto max-w-7xl px-4 py-16 lg:px-6 lg:py-20">
        {eyebrow && <p className="text-sm font-semibold text-accent">{eyebrow}</p>}
        <h1 className="mt-2 max-w-3xl text-4xl font-semibold tracking-tight lg:text-5xl">{title}</h1>
        {intro && <p className="mt-4 max-w-2xl text-lg text-muted">{intro}</p>}
        {children}
      </div>
    </div>
  );
}
