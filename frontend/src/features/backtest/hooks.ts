import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BacktestRun, type BacktestSummary, type Page, type StrategyInfo } from "@/services/api";

export const useStrategies = () => useQuery({ queryKey: ["bt", "strategies"], queryFn: () => api<StrategyInfo[]>("/backtests/strategies"), staleTime: 300_000 });
export const useBacktests = () => useQuery({ queryKey: ["bt", "list"], queryFn: () => api<Page<BacktestSummary>>("/backtests?limit=30") });
export const useBacktest = (id: string | null) =>
  useQuery({ queryKey: ["bt", "run", id], queryFn: () => api<BacktestRun>(`/backtests/${id}`), enabled: !!id });

export function useRunBacktest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api<BacktestRun>("/backtests", { method: "POST", json: body }),
    onSuccess: (r) => {
      qc.setQueryData(["bt", "run", r.id], r);
      qc.invalidateQueries({ queryKey: ["bt", "list"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}
