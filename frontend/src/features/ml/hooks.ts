import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type MLAlgorithm, type MLEvaluation, type MLModelSpec, type MLVersionDetail } from "@/services/api";

export const useAlgorithms = () => useQuery({ queryKey: ["ml", "algorithms"], queryFn: () => api<MLAlgorithm[]>("/ml/algorithms"), staleTime: 300_000 });
export const useModels = () => useQuery({ queryKey: ["ml", "models"], queryFn: () => api<MLModelSpec[]>("/ml/models") });
export const useVersion = (id: string | null) =>
  useQuery({ queryKey: ["ml", "version", id], queryFn: () => api<MLVersionDetail>(`/ml/versions/${id}`), enabled: !!id });

function useInvalidate() {
  const qc = useQueryClient();
  return () => { qc.invalidateQueries({ queryKey: ["ml"] }); qc.invalidateQueries({ queryKey: ["activity"] }); };
}

export function useTrain() {
  const qc = useQueryClient();
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (body: { symbol: string; algorithm: string; horizon: number; days: number }) =>
      api<MLVersionDetail>("/ml/train", { method: "POST", json: body }),
    onSuccess: (v) => { qc.setQueryData(["ml", "version", v.id], v); inv(); },
  });
}
export function useVersionAction() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "promote" | "retire" }) =>
      api<MLVersionDetail>(`/ml/versions/${id}/${action}`, { method: "POST" }),
    onSuccess: inv,
  });
}
export function useDriftCheck() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<MLEvaluation>(`/ml/versions/${id}/drift-check?days=30`, { method: "POST" }),
    onSuccess: inv,
  });
}
