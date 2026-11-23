import { ColorType, createChart, LineSeries, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";

function token(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

export const EQUITY_SERIES = [
  { key: "model", label: "Model strategy", color: "--color-accent" },
  { key: "buy_hold", label: "Buy & hold", color: "--color-info" },
  { key: "momentum", label: "Momentum baseline", color: "--color-subtle" },
] as const;

/** Out-of-sample equity curves (growth of 1) for the model and its baselines. */
export function EquityChart({ times, series, height = 260 }: { times: string[]; series: Record<string, number[]>; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const grid = token("--color-border");
    const chart = createChart(ref.current, {
      height, autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: token("--color-muted"), fontSize: 11, fontFamily: "JetBrains Mono Variable, monospace" },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid }, timeScale: { borderColor: grid },
      localization: { priceFormatter: (p: number) => `${((p - 1) * 100).toFixed(1)}%` },
    });
    const t = times.map((x) => Math.floor(Date.parse(x) / 1000) as UTCTimestamp);
    for (const s of EQUITY_SERIES) {
      const values = series[s.key];
      if (!values) continue;
      const line = chart.addSeries(LineSeries, { color: token(s.color), lineWidth: s.key === "model" ? 2 : 1, priceLineVisible: false, lastValueVisible: true });
      const seen = new Set<number>();
      line.setData(values.flatMap((v, i) => (t[i] == null || seen.has(t[i]!) ? [] : (seen.add(t[i]!), [{ time: t[i]!, value: v }]))));
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [times, series, height]);
  return <div ref={ref} style={{ height }} className="w-full" data-testid="equity-chart" />;
}

/** Reliability diagram: predicted probability vs observed frequency per bin. */
export function CalibrationPlot({ bins }: { bins: { predicted: number; observed: number; count: number }[] }) {
  const W = 260, H = 220, P = 30;
  const x = (v: number) => P + v * (W - P - 8);
  const y = (v: number) => H - P - v * (H - P - 8);
  const maxCount = Math.max(1, ...bins.map((b) => b.count));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[320px]" role="img" aria-label="Calibration plot: predicted versus observed frequency">
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--color-border-strong)" strokeDasharray="4 4" />
      {[0, 0.5, 1].map((v) => (
        <g key={v} fontSize="9" fill="var(--color-subtle)">
          <text x={x(v)} y={H - 12} textAnchor="middle">{v}</text>
          <text x={8} y={y(v) + 3}>{v}</text>
        </g>
      ))}
      <text x={W / 2} y={H - 1} fontSize="9" textAnchor="middle" fill="var(--color-muted)">predicted P(up)</text>
      {bins.map((b) => (
        <circle key={b.predicted} cx={x(b.predicted)} cy={y(b.observed)} r={3 + 5 * Math.sqrt(b.count / maxCount)}
          fill="var(--color-accent)" fillOpacity="0.55" stroke="var(--color-accent)">
          <title>{`predicted ${b.predicted.toFixed(2)} · observed ${b.observed.toFixed(2)} · n=${b.count}`}</title>
        </circle>
      ))}
      {bins.length > 1 && (
        <polyline fill="none" stroke="var(--color-accent)" strokeWidth="1.5"
          points={bins.map((b) => `${x(b.predicted)},${y(b.observed)}`).join(" ")} />
      )}
    </svg>
  );
}
