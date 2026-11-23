import { ColorType, createChart, createSeriesMarkers, HistogramSeries, LineSeries, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";

const token = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";
const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000) as UTCTimestamp;
function dedupe<T extends { time: UTCTimestamp }>(rows: T[]) {
  const seen = new Set<number>();
  return rows.filter((r) => (seen.has(r.time) ? false : (seen.add(r.time), true)));
}

/** Equity (strategy vs buy & hold) with the in-sample/out-of-sample split marked, plus a drawdown pane. */
export function BacktestChart({ strategy, benchmark, split, height = 380 }: { strategy: [string, number][]; benchmark: [string, number][]; split: string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const grid = token("--color-border");
    const chart = createChart(ref.current, {
      height, autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: token("--color-muted"), fontSize: 11, fontFamily: "JetBrains Mono Variable, monospace",
        panes: { separatorColor: grid } },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid }, timeScale: { borderColor: grid },
    });
    const sData = dedupe(strategy.map(([t, v]) => ({ time: ts(t), value: v })));
    const s = chart.addSeries(LineSeries, { color: token("--color-accent"), lineWidth: 2, priceLineVisible: false });
    s.setData(sData);
    chart.addSeries(LineSeries, { color: token("--color-info"), lineWidth: 1, priceLineVisible: false })
      .setData(dedupe(benchmark.map(([t, v]) => ({ time: ts(t), value: v }))));
    const splitT = ts(split);
    const at = sData.find((d) => d.time >= splitT);
    if (at) createSeriesMarkers(s, [{ time: at.time, position: "aboveBar", shape: "arrowDown", color: token("--color-warning"), text: "Out-of-sample →" }]);
    let peak = -Infinity;
    const dd = sData.map((d) => { peak = Math.max(peak, d.value); return { time: d.time, value: -(1 - d.value / peak) * 100, color: token("--color-negative") + "aa" }; });
    chart.addSeries(HistogramSeries, { priceLineVisible: false, priceFormat: { type: "custom", formatter: (v: number) => `${v.toFixed(1)}%` } }, 1).setData(dd);
    chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 3 : 1));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [strategy, benchmark, split, height]);
  return <div ref={ref} style={{ height }} className="w-full" data-testid="backtest-chart" />;
}
