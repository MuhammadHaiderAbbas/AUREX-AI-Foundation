import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AgentRun, type AIAgent, type Page, type RunSummary, type TradeProposal } from "@/services/api";

export const useAgents = () => useQuery({ queryKey: ["ai", "agents"], queryFn: () => api<AIAgent[]>("/ai/agents") });
export const useRuns = () => useQuery({ queryKey: ["ai", "runs"], queryFn: () => api<Page<RunSummary>>("/ai/runs?limit=30") });
export const useRun = (id: string | null) =>
  useQuery({ queryKey: ["ai", "run", id], queryFn: () => api<AgentRun>(`/ai/runs/${id}`), enabled: !!id });
export const useProposals = () =>
  useQuery({ queryKey: ["ai", "proposals"], queryFn: () => api<Page<TradeProposal>>("/ai/proposals?limit=30") });

export function useRunAnalysis() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { symbol: string; account_id?: string }) => api<AgentRun>("/ai/run", { method: "POST", json: body }),
    onSuccess: (run) => {
      qc.setQueryData(["ai", "run", run.id], run);
      qc.invalidateQueries({ queryKey: ["ai", "runs"] });
      qc.invalidateQueries({ queryKey: ["ai", "proposals"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useDismissProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<TradeProposal>(`/ai/proposals/${id}/dismiss`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai"] }),
  });
}

export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, ...body }: { name: string; enabled?: boolean; weight?: number }) =>
      api<AIAgent>(`/ai/agents/${name}`, { method: "PATCH", json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai", "agents"] }),
  });
}
