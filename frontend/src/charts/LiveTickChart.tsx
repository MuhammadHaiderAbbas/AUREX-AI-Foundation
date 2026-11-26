import { ColorType, createChart, LineSeries, LineStyle, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";

const token = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";

export interface StrikeLine { id: string; price: number; direction: "HIGHER" | "LOWER" }
export interface TickPoint { t: number; v: number }

const GAP_S = 20;   // longer than this without data: draw a break, not a straight line

/** Merge history and live ticks, de-duplicated by second, with whitespace where data is missing. */
function series(history: TickPoint[], live: TickPoint[]) {
  const byT = new Map<number, number>();
  for (const p of history) byT.set(p.t, p.v);
  for (const p of live) byT.set(p.t, p.v);
  const pts = [...byT].sort((a, b) => a[0] - b[0]);
  const out: ({ time: UTCTimestamp; value: number } | { time: UTCTimestamp })[] = [];
  for (let i = 0; i < pts.length; i++) {
    const [t, v] = pts[i]!;
    if (i && t - pts[i - 1]![0] > GAP_S * 4) out.push({ time: (pts[i - 1]![0] + 1) as UTCTimestamp });
    out.push({ time: t as UTCTimestamp, value: v });
  }
  return out;
}

/**
 * A live price line. `history` comes from the server's tick history (refetched when the tab
 * regains focus, so time spent away is filled in); `tick` is every streamed quote. The chart is
 * created once per symbol and updated in place, so zoom and scroll survive refreshes.
 */
export function LiveTickChart({ symbol, history, tick, decimals, strikes = [], height = 220 }: {
  symbol: string; history: TickPoint[]; tick: TickPoint | null; decimals: number; strikes?: StrikeLine[]; height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const s = useRef<ISeriesApi<"Line"> | null>(null);
  const liveTicks = useRef<TickPoint[]>([]);
  const lastT = useRef(0);
  const lines = useRef<IPriceLine[]>([]);

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
    s.current = chart.addSeries(LineSeries, { color: token("--color-accent"), lineWidth: 2, priceLineVisible: true, lastValueVisible: true });
    liveTicks.current = [];
    lastT.current = 0;
    lines.current = [];
    return () => { chart.remove(); s.current = null; };
  }, [symbol, decimals, height]);

  // (re)load history in place whenever it is refetched
  useEffect(() => {
    const ser = s.current;
    if (!ser) return;
    const cut = (history[history.length - 1]?.t ?? 0) - 1;
    liveTicks.current = liveTicks.current.filter((p) => p.t > cut);
    const data = series(history, liveTicks.current);
    ser.setData(data);
    lastT.current = (data[data.length - 1]?.time as number | undefined) ?? 0;
  }, [history]);

  useEffect(() => {
    const ser = s.current;
    if (!ser || !tick || tick.t < lastT.current) return;
    if (lastT.current && tick.t - lastT.current > GAP_S * 4) ser.update({ time: (lastT.current + 1) as UTCTimestamp });
    ser.update({ time: tick.t as UTCTimestamp, value: tick.v });
    liveTicks.current.push(tick);
    lastT.current = tick.t;
  }, [tick]);

  const strikeKey = strikes.map((x) => `${x.id}:${x.price}`).join(",");
  useEffect(() => {
    const ser = s.current;
    if (!ser) return;
    for (const l of lines.current) ser.removePriceLine(l);
    lines.current = strikes.map((x) => ser.createPriceLine({
      price: x.price, color: token(x.direction === "HIGHER" ? "--color-positive" : "--color-negative"),
      lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: x.direction === "HIGHER" ? "▲ strike" : "▼ strike",
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strikeKey, symbol]);

  return <div ref={ref} style={{ height }} className="w-full" data-testid="live-tick-chart" />;
}
