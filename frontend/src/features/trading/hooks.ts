import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api, type ClosedPosition, type Execution, type Order, type OrderDetail, type OrderInput, type Page,
  type PortfolioSnapshot, type PortfolioSummary,
} from "@/services/api";

const REFRESH = 10_000;

export const usePortfolio = (accountId: string | undefined) =>
  useQuery({
    queryKey: ["portfolio", accountId, "summary"],
    queryFn: () => api<PortfolioSummary>(`/portfolio/summary?account_id=${accountId}`),
    enabled: !!accountId, refetchInterval: REFRESH,
  });

export const usePortfolioHistory = (accountId: string | undefined) =>
  useQuery({
    queryKey: ["portfolio", accountId, "history"],
    queryFn: () => api<PortfolioSnapshot[]>(`/portfolio/history?account_id=${accountId}`),
    enabled: !!accountId,
  });

export const useClosedPositions = (accountId: string | undefined) =>
  useQuery({
    queryKey: ["portfolio", accountId, "closed"],
    queryFn: () => api<ClosedPosition[]>(`/trading/positions/closed?account_id=${accountId}`),
    enabled: !!accountId,
  });

export const useOrders = (accountId: string | undefined, status?: string) =>
  useQuery({
    queryKey: ["orders", accountId, status ?? "all"],
    queryFn: () => api<Page<Order>>(`/trading/orders?account_id=${accountId}&limit=100${status ? `&status=${status}` : ""}`),
    enabled: !!accountId, refetchInterval: REFRESH,
  });

export const useOrder = (id: string | null) =>
  useQuery({ queryKey: ["order", id], queryFn: () => api<OrderDetail>(`/trading/orders/${id}`), enabled: !!id });

export const useExecutions = (accountId: string | undefined) =>
  useQuery({
    queryKey: ["executions", accountId],
    queryFn: () => api<Page<Execution>>(`/trading/executions?account_id=${accountId}&limit=100`),
    enabled: !!accountId,
  });

function invalidateTrading(qc: ReturnType<typeof useQueryClient>) {
  for (const k of ["portfolio", "orders", "order", "executions", "accounts", "activity"]) qc.invalidateQueries({ queryKey: [k] });
}

export function usePlaceOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (o: OrderInput) => api<OrderDetail>("/trading/orders", { method: "POST", json: o }),
    onSuccess: () => invalidateTrading(qc),
  });
}

export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<OrderDetail>(`/trading/orders/${id}/cancel`, { method: "POST" }),
    onSuccess: () => invalidateTrading(qc),
  });
}
