import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BinaryConfig, type BinaryContract, type BinaryDirection, type BinaryStats, type Page } from "@/services/api";

export const useBinaryConfig = () =>
  useQuery({ queryKey: ["binary", "config"], queryFn: () => api<BinaryConfig>("/binary/config"), staleTime: 300_000 });

export const useBinaryContracts = (accountId: string | undefined, hasOpen: boolean) =>
  useQuery({ queryKey: ["binary", accountId, "contracts"], enabled: !!accountId,
    queryFn: () => api<Page<BinaryContract>>(`/binary/contracts?account_id=${accountId}&limit=100`),
    refetchInterval: hasOpen ? 2000 : 15_000 });

export const useBinaryStats = (accountId: string | undefined) =>
  useQuery({ queryKey: ["binary", accountId, "stats"], enabled: !!accountId,
    queryFn: () => api<BinaryStats>(`/binary/stats?account_id=${accountId}`), refetchInterval: 15_000 });

export function useOpenBinary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { account_id: string; symbol: string; direction: BinaryDirection; stake: string; expiry_seconds: number; client_id: string }) =>
      api<BinaryContract>("/binary/contracts", { method: "POST", json: v }),
    onSettled: () => { for (const k of ["binary", "portfolio", "risk", "accounts"]) qc.invalidateQueries({ queryKey: [k] }); },
  });
}
