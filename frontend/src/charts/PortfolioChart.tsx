import { AreaSeries, ColorType, createChart, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { LivePoint } from "@/features/live/stream";
import type { PortfolioSnapshot } from "@/services/api";

const token = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";

/**
 * Equity over time: stored snapshots (taken on every fill and hourly) followed by the live
 * mark-to-market points streamed every couple of seconds, appended without a redraw.
 */
export function PortfolioChart({ snapshots, live = [], height = 240 }: { snapshots: PortfolioSnapshot[]; live?: LivePoint[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const series = useRef<ISeriesApi<"Area"> | null>(null);
  const lastT = useRef(0);
  const liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => {
    if (!ref.current) return;
    const grid = token("--color-border");
    const chart = createChart(ref.current, {
      height, autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: token("--color-muted"), fontSize: 11, fontFamily: "JetBrains Mono Variable, monospace" },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid }, timeScale: { borderColor: grid, timeVisible: true, secondsVisible: true },
    });
    const accent = token("--color-accent");
    const s = chart.addSeries(AreaSeries, { lineColor: accent, topColor: accent + "55", bottomColor: accent + "05", lineWidth: 2, priceLineVisible: true });
    const byTime = new Map<number, number>();   // last value within a second wins
    for (const p of snapshots) byTime.set(Math.floor(Date.parse(p.taken_at) / 1000), Number(p.equity));
    const lastSnap = Math.max(0, ...byTime.keys());
    for (const p of liveRef.current) if (p.t > lastSnap) byTime.set(p.t, p.equity);
    const data = [...byTime].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ time: t as UTCTimestamp, value: v }));
    s.setData(data);
    series.current = s;
    lastT.current = data.length ? (data[data.length - 1]!.time as number) : 0;
    chart.timeScale().fitContent();
    return () => { chart.remove(); series.current = null; };
  }, [snapshots, height]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const p of live) {
      if (p.t < lastT.current) continue;
      s.update({ time: p.t as UTCTimestamp, value: p.equity });
      lastT.current = p.t;
    }
  }, [live, live.length, live[live.length - 1]?.t, live[live.length - 1]?.equity]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={ref} style={{ height }} className="w-full" data-testid="portfolio-chart" />;
}
