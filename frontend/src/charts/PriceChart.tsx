import {
  CandlestickSeries, ColorType, createChart, CrosshairMode, HistogramSeries, LineSeries,
  type IChartApi, type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { CandlesResponse } from "@/services/api";

// Read design tokens so the chart follows the theme.
function token(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

const OVERLAYS: Record<string, string> = { sma20: "#5b8def", sma50: "#b07cf0", ema20: "#e5b454", ema50: "#f07ca8" };

const SUB_PANE = 120;

export function PriceChart({ data, decimals, height: mainHeight = 420 }: { data: CandlesResponse; decimals: number; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const subPanes = (data.indicators.rsi14 ? 1 : 0) + (data.indicators.macd ? 1 : 0);
  const height = mainHeight + subPanes * SUB_PANE;
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const up = token("--color-positive");
    const down = token("--color-negative");
    const grid = token("--color-border");
    const chart = createChart(el, {
      height,
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: token("--color-muted"),
        fontFamily: "JetBrains Mono Variable, ui-monospace, monospace",
        fontSize: 11,
        panes: { separatorColor: grid, separatorHoverColor: token("--color-border-strong") },
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: grid },
      timeScale: { borderColor: grid, timeVisible: data.timeframe !== "1d", secondsVisible: false },
      localization: { priceFormatter: (p: number) => p.toFixed(decimals) },
    });
    chartRef.current = chart;

    const t = (iso: string) => (Date.parse(iso) / 1000) as UTCTimestamp;
    const times = data.candles.map((c) => t(c.open_time));
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
      priceFormat: { type: "price", precision: decimals, minMove: 1 / 10 ** decimals },
    });
    candles.setData(data.candles.map((c, i) => ({
      time: times[i]!, open: +c.open, high: +c.high, low: +c.low, close: +c.close,
    })));

    const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(data.candles.map((c, i) => ({
      time: times[i]!, value: +c.volume,
      color: (+c.close >= +c.open ? up : down) + "55",
    })));

    const line = (values: (number | null)[], color: string, pane = 0, width: 1 | 2 = 1) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, pane);
      s.setData(values.flatMap((v, i) => (v == null ? [] : [{ time: times[i]!, value: v }])));
      return s;
    };
    for (const [k, color] of Object.entries(OVERLAYS)) {
      const v = data.indicators[k as keyof typeof OVERLAYS & keyof CandlesResponse["indicators"]];
      if (Array.isArray(v)) line(v, color, 0, 2);
    }
    if (data.indicators.bb20) {
      const bb = data.indicators.bb20;
      line(bb.upper, token("--color-subtle"));
      line(bb.middle, token("--color-subtle"));
      line(bb.lower, token("--color-subtle"));
    }
    let pane = 1;
    if (data.indicators.rsi14) {
      const rsi = line(data.indicators.rsi14, token("--color-accent"), pane, 1);
      rsi.createPriceLine({ price: 70, color: down, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
      rsi.createPriceLine({ price: 30, color: up, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
      pane++;
    }
    if (data.indicators.macd) {
      const m = data.indicators.macd;
      const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
      hist.setData(m.histogram.flatMap((v, i) => (v == null ? [] : [{ time: times[i]!, value: v, color: (v >= 0 ? up : down) + "99" }])));
      line(m.macd, token("--color-info"), pane);
      line(m.signal, token("--color-warning"), pane);
      pane++;
    }
    // Proportional sizing: stretch factors are relative, so use pixel targets as weights.
    chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? mainHeight : SUB_PANE));
    chart.timeScale().fitContent();
    return () => { chart.remove(); chartRef.current = null; };
  }, [data, decimals, height, mainHeight]);

  return <div ref={ref} className="w-full" style={{ height }} data-testid="price-chart" />;
}
