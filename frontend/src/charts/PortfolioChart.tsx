import { AreaSeries, ColorType, createChart, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { PortfolioSnapshot } from "@/services/api";

const token = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";

/** Equity over time from portfolio snapshots (taken on every fill and hourly). */
export function PortfolioChart({ snapshots, height = 240 }: { snapshots: PortfolioSnapshot[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const grid = token("--color-border");
    const chart = createChart(ref.current, {
      height, autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: token("--color-muted"), fontSize: 11, fontFamily: "JetBrains Mono Variable, monospace" },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid }, timeScale: { borderColor: grid, timeVisible: true },
    });
    const accent = token("--color-accent");
    const s = chart.addSeries(AreaSeries, { lineColor: accent, topColor: accent + "55", bottomColor: accent + "05", lineWidth: 2, priceLineVisible: false });
    const byTime = new Map<number, number>();   // last snapshot within a second wins
    for (const p of snapshots) byTime.set(Math.floor(Date.parse(p.taken_at) / 1000), Number(p.equity));
    s.setData([...byTime].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ time: t as UTCTimestamp, value: v })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [snapshots, height]);
  return <div ref={ref} style={{ height }} className="w-full" data-testid="portfolio-chart" />;
}
