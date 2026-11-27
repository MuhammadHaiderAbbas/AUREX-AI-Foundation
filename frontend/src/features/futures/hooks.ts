import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type FuturesBook, type FuturesConfig, type FuturesPosition, type FuturesPreview, type FuturesSide, type FuturesSignal } from "@/services/api";

export const useFuturesConfig = () =>
  useQuery({ queryKey: ["futures", "config"], queryFn: () => api<FuturesConfig>("/futures/config"), staleTime: 60_000 });

export const useFuturesBook = (symbol: string) =>
  useQuery({ queryKey: ["futures", "book", symbol], queryFn: () => api<FuturesBook>(`/futures/book?symbol=${encodeURIComponent(symbol)}&depth=10`), refetchInterval: 2000 });

export const useFuturesPreview = (v: { account_id?: string; symbol: string; side: FuturesSide; margin: string; leverage: number }) =>
  useQuery({ queryKey: ["futures", "preview", v], enabled: !!v.account_id && Number(v.margin) > 0, refetchInterval: 3000, retry: false,
    queryFn: () => api<FuturesPreview>(`/futures/preview?${new URLSearchParams({ account_id: v.account_id!, symbol: v.symbol, side: v.side, margin: v.margin, leverage: String(v.leverage) })}`) });

export const useFuturesPositions = (accountId: string | undefined) =>
  useQuery({ queryKey: ["futures", accountId, "positions"], enabled: !!accountId, refetchInterval: 2000,
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
