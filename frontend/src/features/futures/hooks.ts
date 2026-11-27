import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type FuturesBook, type FuturesBot, type FuturesConfig, type FuturesPosition, type FuturesPreview, type FuturesSide, type FuturesSignal } from "@/services/api";

export const useFuturesConfig = () =>
  useQuery({ queryKey: ["futures", "config"], queryFn: () => api<FuturesConfig>("/futures/config"), staleTime: 60_000 });

export const useFuturesBook = (symbol: string) =>
  useQuery({ queryKey: ["futures", "book", symbol], queryFn: () => api<FuturesBook>(`/futures/book?symbol=${encodeURIComponent(symbol)}&depth=10`), refetchInterval: 3000 });

export const useFuturesPreview = (v: { account_id?: string; symbol: string; side: FuturesSide; margin: string; leverage: number }) =>
  useQuery({ queryKey: ["futures", "preview", v], enabled: !!v.account_id && Number(v.margin) > 0, refetchInterval: 6000, retry: false,   // also refetches at once when an input changes
    queryFn: () => api<FuturesPreview>(`/futures/preview?${new URLSearchParams({ account_id: v.account_id!, symbol: v.symbol, side: v.side, margin: v.margin, leverage: String(v.leverage) })}`) });

export const useFuturesPositions = (accountId: string | undefined) =>
  useQuery({ queryKey: ["futures", accountId, "positions"], enabled: !!accountId,
    refetchInterval: (q) => (q.state.data?.some((p) => p.status === "OPEN") ? 3000 : 15_000),   // marks move only while something is open
    queryFn: () => api<FuturesPosition[]>(`/futures/positions?account_id=${accountId}`) });

export const useFuturesSignal = (symbol: string, enabled: boolean) =>
  useQuery({ queryKey: ["futures", "signal", symbol], enabled, staleTime: 120_000, queryFn: () => api<FuturesSignal>(`/futures/signal?symbol=${encodeURIComponent(symbol)}`) });

const invalidate = (qc: ReturnType<typeof useQueryClient>) => { for (const k of ["futures", "portfolio", "risk", "accounts"]) qc.invalidateQueries({ queryKey: [k] }); };

export function useOpenFutures() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { account_id: string; symbol: string; side: FuturesSide; margin: string; leverage: number; client_id: string }) =>
      api<FuturesPosition>("/futures/positions", { method: "POST", json: v }),
    onSettled: () => invalidate(qc),
  });
}

export function useCloseFutures() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api<FuturesPosition>(`/futures/positions/${id}/close`, { method: "POST" }), onSettled: () => invalidate(qc) });
}

export const useFuturesBot = (accountId: string | undefined) =>
  useQuery({ queryKey: ["futures", accountId, "bot"], enabled: !!accountId, refetchInterval: (q) => (q.state.data?.status === "RUNNING" ? 5000 : 15_000),
    queryFn: () => api<FuturesBot>(`/futures/bot?account_id=${accountId}`) });

export function useFuturesBotControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { account_id: string; action: "start" | "pause" | "stop"; symbols?: string[]; margin_pct?: number; max_leverage?: number }) =>
      api<FuturesBot>("/futures/bot", { method: "POST", json: v }),
    // a status poll already in flight must not overwrite the new state with the old one
    onMutate: (v) => qc.cancelQueries({ queryKey: ["futures", v.account_id, "bot"] }),
    onSuccess: (b) => qc.setQueryData(["futures", b.account_id, "bot"], b),
    onSettled: () => invalidate(qc),
  });
}

export function useFuturesBotRun() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (accountId: string) => api<unknown>(`/futures/bot/run?account_id=${accountId}`, { method: "POST" }), onSettled: () => invalidate(qc) });
}
