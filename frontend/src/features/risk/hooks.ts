import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api, type AutopilotCycle, type Page, type ProposalExecution, type RiskDecision, type RiskEvent, type RiskLimits,
  type RiskOverview, type SystemHalt,
} from "@/services/api";

export const useSystemHalt = () =>
  useQuery({ queryKey: ["risk", "system"], queryFn: () => api<SystemHalt>("/risk/status"), refetchInterval: 30_000 });

export const useRiskOverview = (accountId: string | undefined) =>
  useQuery({ queryKey: ["risk", accountId, "overview"], queryFn: () => api<RiskOverview>(`/risk/accounts/${accountId}`),
    enabled: !!accountId, refetchInterval: 10_000 });

export const useRiskDecisions = (accountId: string | undefined, approved?: boolean) =>
  useQuery({ queryKey: ["risk", accountId, "decisions", approved ?? "all"],
    queryFn: () => api<Page<RiskDecision>>(`/risk/decisions?account_id=${accountId}&limit=50${approved === undefined ? "" : `&approved=${approved}`}`),
    enabled: !!accountId });

export const useRiskEvents = (accountId: string | undefined) =>
  useQuery({ queryKey: ["risk", accountId, "events"], queryFn: () => api<Page<RiskEvent>>(`/risk/events?account_id=${accountId}&limit=50`),
    enabled: !!accountId, refetchInterval: 15_000 });

function useRiskMutation<V, R = RiskOverview>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const k of ["risk", "orders", "order", "portfolio", "executions", "accounts", "activity", "ai"]) qc.invalidateQueries({ queryKey: [k] });
    },
  });
}

export const useUpdateLimits = (id: string | undefined) =>
  useRiskMutation((limits: Partial<RiskLimits>) => api<RiskOverview>(`/risk/accounts/${id}/limits`, { method: "PUT", json: limits }));
export const useKillSwitch = (id: string | undefined) =>
  useRiskMutation((v: { engaged: boolean; reason?: string }) => api<RiskOverview>(`/risk/accounts/${id}/kill-switch`, { method: "POST", json: v }));
export const useResetDrawdown = (id: string | undefined) =>
  useRiskMutation(() => api<RiskOverview>(`/risk/accounts/${id}/breakers/drawdown/reset`, { method: "POST" }));
export const useAutopilot = (id: string | undefined) =>
  useRiskMutation((v: { action: "start" | "pause" | "stop"; symbols?: string[] }) => api<RiskOverview>(`/risk/accounts/${id}/autopilot`, { method: "POST", json: v }));
export const useAutopilotCycle = (id: string | undefined) =>
  useRiskMutation(() => api<AutopilotCycle>(`/risk/accounts/${id}/autopilot/run`, { method: "POST" }));
export const useEmergencyStop = (id: string | undefined) =>
  useRiskMutation((v: { flatten: boolean }) => api<RiskOverview>(`/risk/accounts/${id}/emergency-stop`, { method: "POST", json: v }));
export const useExecuteProposal = () =>
  useRiskMutation((proposalId: string) => api<ProposalExecution>(`/ai/proposals/${proposalId}/execute`, { method: "POST" }));
export const useSystemHaltControl = () =>
  useRiskMutation((v: { halted: boolean; reason?: string }) => api<SystemHalt>("/admin/risk/halt", { method: "POST", json: v }));
