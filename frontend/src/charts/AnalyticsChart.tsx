import { ColorType, createChart, HistogramSeries, LineSeries, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";

const token = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";
const day = (d: string) => Math.floor(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) / 1000) as UTCTimestamp;

/** Time-weighted growth of the account vs a benchmark, with a drawdown pane. */
export function AnalyticsChart({ daily, benchmark, height = 360 }: {
  daily: { date: string; growth: number; drawdown: number }[]; benchmark?: { date: string; growth: number }[]; height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const grid = token("--color-border");
    const chart = createChart(ref.current, {
      height, autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: token("--color-muted"), fontSize: 11,
        fontFamily: "JetBrains Mono Variable, monospace", panes: { separatorColor: grid } },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid }, timeScale: { borderColor: grid },
    });
    // growth of 1 shown as a % change; set per series so the drawdown pane keeps its own scale
    const growthFmt = { type: "custom" as const, formatter: (p: number) => `${((p - 1) * 100).toFixed(1)}%`, minMove: 0.0001 };
    const uniq = <T extends { time: UTCTimestamp }>(rows: T[]) => { const m = new Map<number, T>(); rows.forEach((r) => m.set(r.time, r)); return [...m.values()].sort((a, b) => a.time - b.time); };
    chart.addSeries(LineSeries, { color: token("--color-accent"), lineWidth: 2, priceLineVisible: false, title: "Account", priceFormat: growthFmt })
      .setData(uniq(daily.map((d) => ({ time: day(d.date), value: d.growth }))));
    if (benchmark?.length) {
      chart.addSeries(LineSeries, { color: token("--color-info"), lineWidth: 1, priceLineVisible: false, title: "Benchmark", priceFormat: growthFmt })
        .setData(uniq(benchmark.map((d) => ({ time: day(d.date), value: d.growth }))));
    }
    chart.addSeries(HistogramSeries, { priceLineVisible: false, priceFormat: { type: "custom", formatter: (v: number) => `${v.toFixed(1)}%`, minMove: 0.01 } }, 1)
      .setData(uniq(daily.map((d) => ({ time: day(d.date), value: d.drawdown * 100, color: token("--color-negative") + "aa" }))));
    chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 3 : 1));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [daily, benchmark, height]);
  return <div ref={ref} style={{ height }} className="w-full" data-testid="analytics-chart" />;
}
