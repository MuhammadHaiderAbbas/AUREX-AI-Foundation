import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { api, isDemo, tokenStore, type PortfolioSummary, type TradingAccount } from "@/services/api";

/**
 * Live account layer. One WebSocket (/stream/account) per signed-in tab pushes:
 *   - "changed": which topics moved for an account (orders, fills, ledger, positions, binaries, risk),
 *     so the matching queries refetch at once instead of waiting for a poll;
 *   - "valuation": a mark-to-market snapshot every couple of seconds, fed straight into the
 *     cached portfolio summary and into an intraday equity series for the charts.
 * If the socket is unavailable (and always in the static demo) it falls back to polling every 2 s.
 */

export type LiveMode = "connecting" | "live" | "polling" | "off";
export interface LivePoint { t: number; equity: number }
export interface Valuation {
  account_id: string; as_of: string; equity: string; cash: string; available_cash: string; market_value: string;
  unrealised_pnl: string; realised_pnl: string; fees: string; exposure: number; binary_at_risk: string; open_positions: number;
  positions: { symbol: string; last: string; bid: string; market_value: string; unrealised_pnl: string; unrealised_pct: number; price_as_of: string | null; stale: boolean }[];
}

const MAX_POINTS = 3600;
const POLL_MS = 2000;
const state = { mode: "off" as LiveMode, lastEventAt: 0, series: {} as Record<string, LivePoint[]>, version: 0 };
const listeners = new Set<() => void>();
const emit = () => { state.version++; for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

export function useLiveMode(): { mode: LiveMode; lastEventAt: number } {
  useSyncExternalStore(subscribe, () => state.version);
  return { mode: state.mode, lastEventAt: state.lastEventAt };
}

/** Intraday equity points received live for an account (newest last). */
export function useLiveEquity(accountId: string | undefined): LivePoint[] {
  useSyncExternalStore(subscribe, () => state.version);
  return (accountId && state.series[accountId]) || EMPTY;
}
const EMPTY: LivePoint[] = [];

function setMode(mode: LiveMode) { if (state.mode !== mode) { state.mode = mode; emit(); } }

function pushPoint(accountId: string, at: string | number, equity: number) {
  const t = Math.floor((typeof at === "number" ? at : Date.parse(at)) / 1000);
  const arr = (state.series[accountId] ??= []);
  const lastPt = arr[arr.length - 1];
  if (lastPt && lastPt.t === t) lastPt.equity = equity;
  else if (!lastPt || t > lastPt.t) arr.push({ t, equity });
  if (arr.length > MAX_POINTS) arr.splice(0, arr.length - MAX_POINTS);
  state.lastEventAt = Date.now();
  emit();
}

const TOPIC_KEYS: Record<string, string[][]> = {
  orders: [["orders"], ["order"]],
  executions: [["executions"], ["portfolio"], ["analytics"]],
  ledger: [["accounts"], ["activity"], ["analytics"]],
  positions: [["portfolio"]],
  binary: [["binary"], ["portfolio"]],
  risk: [["risk"]],
  accounts: [["accounts"]],
};

export function applyChanged(qc: QueryClient, topics: string[]) {
  const seen = new Set<string>();
  for (const t of topics) for (const key of TOPIC_KEYS[t] ?? []) {
    const k = key.join("/");
    if (seen.has(k)) continue;
    seen.add(k);
    qc.invalidateQueries({ queryKey: key });
  }
  state.lastEventAt = Date.now();
  emit();
}

/** Merge a live valuation into the cached portfolio summary (positions matched by symbol). */
export function applyValuation(qc: QueryClient, v: Valuation) {
  qc.setQueryData<PortfolioSummary>(["portfolio", v.account_id, "summary"], (prev) => {
    if (!prev) return prev;
    const bySym = new Map(v.positions.map((p) => [p.symbol, p]));
    return {
      ...prev, equity: v.equity, cash: v.cash, available_cash: v.available_cash, market_value: v.market_value,
      unrealised_pnl: v.unrealised_pnl, realised_pnl: v.realised_pnl, fees: v.fees, exposure: v.exposure, binary_at_risk: v.binary_at_risk,
      positions: prev.positions.map((p) => {
        const live = bySym.get(p.symbol);
        return live ? { ...p, last: live.last, bid: live.bid, market_value: live.market_value, unrealised_pnl: live.unrealised_pnl,
          unrealised_pct: live.unrealised_pct, price_as_of: live.price_as_of, stale: live.stale } : p;
      }),
    };
  });
  pushPoint(v.account_id, v.as_of, Number(v.equity));
}

/** Polling fallback: refresh summaries; refetch trading queries only when something moved. */
function startPolling(qc: QueryClient): () => void {
  setMode("polling");
  const prints: Record<string, string> = {};
  let stopped = false;
  const run = async () => {
    const accounts = qc.getQueryData<TradingAccount[]>(["accounts"]) ?? await api<TradingAccount[]>("/accounts").catch(() => []);
    for (const a of accounts) {
      const s = await api<PortfolioSummary>(`/portfolio/summary?account_id=${a.id}`).catch(() => null);
      if (!s || stopped) continue;
      const fp = [s.cash, s.open_positions, s.binary_at_risk ?? "0", s.realised_pnl, s.positions.map((p) => p.quantity).join(",")].join("|");
      qc.setQueryData(["portfolio", a.id, "summary"], s);
      pushPoint(a.id, Date.now(), Number(s.equity));
      if (prints[a.id] !== undefined && prints[a.id] !== fp) applyChanged(qc, ["orders", "executions", "ledger", "binary", "risk"]);
      prints[a.id] = fp;
    }
    // resting orders and binary contracts settle on read in the demo, so keep them fresh too
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["binary"] });
  };
  run();
  const timer = setInterval(run, POLL_MS);
  return () => { stopped = true; clearInterval(timer); };
}

/** Mount once inside the authenticated shell. */
export function useAccountStream(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) { setMode("off"); return; }
    if (isDemo || typeof WebSocket === "undefined") return startPolling(qc);

    let ws: WebSocket | null = null, stopPoll: (() => void) | null = null, retry: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false, attempt = 0;
    const connect = () => {
      setMode("connecting");
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/v1/stream/account`);
      ws.onopen = () => ws!.send(JSON.stringify({ type: "auth", token: tokenStore.get() }));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "ready") {
          attempt = 0; stopPoll?.(); stopPoll = null; setMode("live");
          applyChanged(qc, ["orders", "executions", "ledger", "binary", "risk"]);   // catch up on anything missed
        } else if (msg.type === "changed") applyChanged(qc, msg.topics as string[]);
        else if (msg.type === "valuation") applyValuation(qc, msg as Valuation);
      };
      ws.onclose = () => {
        if (cancelled) return;
        if (!stopPoll) stopPoll = startPolling(qc);       // keep data moving while we reconnect
        retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
      };
    };
    connect();
    return () => {
      cancelled = true; clearTimeout(retry); stopPoll?.();
      if (ws) { ws.onclose = null; ws.close(); }
      setMode("off");
    };
  }, [enabled, qc]);
}
