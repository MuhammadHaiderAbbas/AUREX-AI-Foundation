import { ColorType, createChart, LineSeries, LineStyle, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";

const token = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";

export interface StrikeLine { id: string; price: number; direction: "HIGHER" | "LOWER" }

/**
 * A live price line: seeded with recent 1-minute closes, then one point per streamed quote.
 * Open binary contracts on the same instrument are drawn as strike lines (green HIGHER, red LOWER).
 */
export function LiveTickChart({ symbol, seed, tick, decimals, strikes = [], height = 220 }: {
  symbol: string; seed: { t: number; v: number }[]; tick: { t: number; v: number } | null; decimals: number; strikes?: StrikeLine[]; height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const series = useRef<ISeriesApi<"Line"> | null>(null);
  const lastT = useRef(0);
  const lines = useRef<IPriceLine[]>([]);
  const seedKey = `${symbol}|${seed.length > 0}`;   // build once per symbol; live ticks extend it

  useEffect(() => {
    if (!ref.current) return;
    const grid = token("--color-border");
    const chart = createChart(ref.current, {
      height, autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: token("--color-muted"), fontSize: 11, fontFamily: "JetBrains Mono Variable, monospace" },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid }, timeScale: { borderColor: grid, timeVisible: true, secondsVisible: true },
      localization: { priceFormatter: (p: number) => p.toFixed(decimals) },
    });
    const s = chart.addSeries(LineSeries, { color: token("--color-accent"), lineWidth: 2, priceLineVisible: true, lastValueVisible: true });
    const dedup = new Map<number, number>();
    for (const p of seed) dedup.set(p.t, p.v);
    const data = [...dedup].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ time: t as UTCTimestamp, value: v }));
    s.setData(data);
    lastT.current = data.length ? (data[data.length - 1]!.time as number) : 0;
    series.current = s;
    lines.current = [];
    chart.timeScale().fitContent();
    return () => { chart.remove(); series.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey, decimals, height]);

  useEffect(() => {
    const s = series.current;
    if (!s || !tick || tick.t < lastT.current) return;
    s.update({ time: tick.t as UTCTimestamp, value: tick.v });
    lastT.current = tick.t;
  }, [tick]);

  const strikeKey = strikes.map((x) => `${x.id}:${x.price}`).join(",");
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const l of lines.current) s.removePriceLine(l);
    lines.current = strikes.map((x) => s.createPriceLine({
      price: x.price, color: token(x.direction === "HIGHER" ? "--color-positive" : "--color-negative"),
      lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: x.direction === "HIGHER" ? "▲ strike" : "▼ strike",
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strikeKey, seedKey]);

  return <div ref={ref} style={{ height }} className="w-full" data-testid="live-tick-chart" />;
}
