import { useQuery } from "@tanstack/react-query";
import {
  api, type AIReport, type AnalyticsPeriod, type ExecutionReport, type FullReport, type Performance, type RiskReport, type TradesReport,
} from "@/services/api";

const useSection = <T,>(section: string, id: string | undefined, period: AnalyticsPeriod, extra = "", enabled = true) =>
  useQuery({
    queryKey: ["analytics", id, section, period, extra],
    queryFn: () => api<T>(`/analytics/accounts/${id}/${section}?period=${period}${extra}`),
    enabled: !!id && enabled, staleTime: 30_000,
  });

export const usePerformance = (id: string | undefined, period: AnalyticsPeriod, benchmark: string, enabled = true) =>
  useSection<Performance>("performance", id, period, `&benchmark=${encodeURIComponent(benchmark)}`, enabled);
export const useTradesReport = (id: string | undefined, period: AnalyticsPeriod, enabled = true) => useSection<TradesReport>("trades", id, period, "", enabled);
export const useExecutionReport = (id: string | undefined, period: AnalyticsPeriod, enabled = true) => useSection<ExecutionReport>("execution", id, period, "", enabled);
export const useRiskReport = (id: string | undefined, period: AnalyticsPeriod, enabled = true) => useSection<RiskReport>("risk", id, period, "", enabled);
export const useAIReport = (id: string | undefined, period: AnalyticsPeriod, horizon: number, enabled = true) =>
  useSection<AIReport>("ai", id, period, `&horizon_hours=${horizon}`, enabled);
export const useFullReport = (id: string | undefined, period: AnalyticsPeriod, enabled: boolean) => useSection<FullReport>("report", id, period, "", enabled);
