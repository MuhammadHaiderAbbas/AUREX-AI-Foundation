import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, isDemo, tokenStore, type CandlesResponse, type MarketOverview, type Quote, type Watchlist } from "@/services/api";

export const useMarketOverview = () =>
  useQuery({ queryKey: ["markets", "overview"], queryFn: () => api<MarketOverview>("/markets/overview"), refetchInterval: 30_000 });

export const useWatchlist = () =>
  useQuery({ queryKey: ["markets", "watchlist"], queryFn: () => api<Watchlist>("/markets/watchlist") });

export function useCandles(slug: string | undefined, timeframe: string, indicators: string[]) {
  const ind = [...indicators].sort().join(",");
  return useQuery({
    queryKey: ["markets", "candles", slug, timeframe, ind],
    queryFn: () => api<CandlesResponse>(
      `/markets/instruments/${slug}/candles?timeframe=${timeframe}&limit=300${ind ? `&indicators=${ind}` : ""}`),
    enabled: !!slug,
    refetchInterval: 60_000,
    placeholderData: (prev) => (prev?.symbol && prev.timeframe === timeframe ? prev : undefined),
  });
}

export function useWatchlistToggle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, on }: { slug: string; on: boolean }) =>
      on
        ? api<Watchlist>("/markets/watchlist/items", { method: "POST", json: { symbol: slug } })
        : api<Watchlist>(`/markets/watchlist/items/${slug}`, { method: "DELETE" }),
    onSuccess: (wl) => qc.setQueryData(["markets", "watchlist"], wl),
  });
}

/**
 * Live quotes for a set of symbols. Uses the WebSocket stream; falls back to polling
 * the overview endpoint if the socket cannot be established (and always in demo mode).
 */
export function useLiveQuotes(symbols: string[]): { quotes: Record<string, Quote>; live: boolean } {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [live, setLive] = useState(false);
  const key = symbols.join("|");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!symbols.length) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const poll = () => {
      const run = async () => {
        const ov = await api<MarketOverview>("/markets/overview").catch(() => null);
        if (!ov || cancelled) return;
        const next: Record<string, Quote> = {};
        for (const g of Object.values(ov.groups)) for (const i of g) if (i.quote) next[i.quote.symbol] = i.quote;
        setQuotes((prev) => ({ ...prev, ...next }));
      };
      run();
      pollTimer = setInterval(run, 2000);
    };

    if (isDemo || typeof WebSocket === "undefined") {
      poll();
      let unsub: (() => void) | undefined, last = 0;
      if (isDemo) import("@/services/demo/live").then((m) => {
        if (cancelled) return;
        unsub = m.onTick(() => {
          const t = Date.now();
          if (t - last < 1000) return;
          last = t;
          api<MarketOverview>("/markets/overview").then((ov) => {
            if (cancelled) return;
            const next: Record<string, Quote> = {};
            for (const g of Object.values(ov.groups)) for (const i of g) if (i.quote) next[i.quote.symbol] = i.quote;
            setQuotes((prev) => ({ ...prev, ...next }));
          }).catch(() => {});
        }) as () => void;
      });
      return () => { cancelled = true; clearInterval(pollTimer); unsub?.(); };
    }

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/v1/markets/stream`);
    wsRef.current = ws;
    let opened = false;
    ws.onopen = () => { opened = true; ws.send(JSON.stringify({ type: "auth", token: tokenStore.get() })); };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "ready") { setLive(true); ws.send(JSON.stringify({ type: "subscribe", symbols })); }
      else if (msg.type === "quotes") {
        setQuotes((prev) => {
          const next = { ...prev };
          for (const q of msg.data as Quote[]) next[q.symbol] = q;
          return next;
        });
      }
    };
    ws.onclose = () => {
      setLive(false);
      if (!cancelled && !pollTimer) poll();
    };
    ws.onerror = () => { if (!opened) ws.close(); };
    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      ws.onclose = null;
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { quotes, live };
}

/** Recent price path for live charts (1-minute closes + recent ticks); refetched on focus so hidden time is filled in. */
export const useTickHistory = (slug: string | undefined, seconds = 1800) =>
  useQuery({
    queryKey: ["markets", "ticks", slug, seconds], enabled: !!slug, refetchInterval: 60_000, refetchOnWindowFocus: "always", staleTime: 5_000,
    queryFn: () => api<{ symbol: string; source: string; points: { t: number; price: number }[] }>(`/markets/instruments/${slug}/ticks?seconds=${seconds}`),
  });
