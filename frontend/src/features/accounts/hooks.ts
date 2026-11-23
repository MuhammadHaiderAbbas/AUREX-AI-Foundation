import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type AccountBalances,
  type AuditLog,
  type LedgerTransaction,
  type Page,
  type SystemInfo,
  type TradingAccount,
} from "@/services/api";

export const useSystemInfo = () =>
  useQuery({ queryKey: ["system-info"], queryFn: () => api<SystemInfo>("/system/info"), staleTime: 60_000 });

export const useAccounts = () =>
  useQuery({ queryKey: ["accounts"], queryFn: () => api<TradingAccount[]>("/accounts") });

export const useBalances = (id: string | undefined) =>
  useQuery({
    queryKey: ["accounts", id, "balances"],
    queryFn: () => api<AccountBalances>(`/accounts/${id}/balances`),
    enabled: !!id,
  });

export const useLedger = (id: string | undefined, limit = 50) =>
  useQuery({
    queryKey: ["accounts", id, "ledger", limit],
    queryFn: () => api<Page<LedgerTransaction>>(`/accounts/${id}/ledger?limit=${limit}`),
    enabled: !!id,
  });

export const useMyActivity = () =>
  useQuery({ queryKey: ["activity"], queryFn: () => api<AuditLog[]>("/users/me/activity?limit=12") });

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; base_currency: string; starting_balance?: string }) =>
      api<TradingAccount>("/accounts", { method: "POST", json: body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["accounts"] }); qc.invalidateQueries({ queryKey: ["activity"] }); },
  });
}

export function useCashMovement(accountId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { kind: "deposits" | "withdrawals"; amount: string; description: string; key: string }) =>
      api<LedgerTransaction>(`/accounts/${accountId}/${v.kind}`, {
        method: "POST",
        json: { amount: v.amount, description: v.description },
        idempotencyKey: v.key,
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["accounts"] }); qc.invalidateQueries({ queryKey: ["activity"] }); },
  });
}
