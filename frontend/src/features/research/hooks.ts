import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api, type IngestResult, type Page, type ReportSummary, type ResearchDocument,
  type ResearchDocumentDetail, type ResearchReport, type ResearchStatus, type SearchHit,
} from "@/services/api";

export const useResearchStatus = () =>
  useQuery({ queryKey: ["research", "status"], queryFn: () => api<ResearchStatus>("/research/status") });

export const useDocuments = (filters: { doc_type?: string; symbol?: string; q?: string }) => {
  const qs = new URLSearchParams({ limit: "200" });
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  return useQuery({ queryKey: ["research", "documents", filters], queryFn: () => api<Page<ResearchDocument>>(`/research/documents?${qs}`) });
};

export const useDocument = (id: string | null) =>
  useQuery({ queryKey: ["research", "document", id], queryFn: () => api<ResearchDocumentDetail>(`/research/documents/${id}`), enabled: !!id });

export const useReports = () =>
  useQuery({ queryKey: ["research", "reports"], queryFn: () => api<Page<ReportSummary>>("/research/reports?limit=30") });

export const useReport = (id: string | null) =>
  useQuery({ queryKey: ["research", "report", id], queryFn: () => api<ResearchReport>(`/research/reports/${id}`), enabled: !!id });

export const useSearch = (q: string) =>
  useQuery({ queryKey: ["research", "search", q], queryFn: () => api<SearchHit[]>(`/research/search?q=${encodeURIComponent(q)}&k=10`), enabled: q.trim().length >= 2 });

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["research"] });
}

export function useAsk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { question: string; symbols: string[]; max_age_days?: number }) =>
      api<ResearchReport>("/research/ask", { method: "POST", json: body }),
    onSuccess: (r) => {
      qc.setQueryData(["research", "report", r.id], r);
      qc.invalidateQueries({ queryKey: ["research", "reports"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useLoadSamples() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: () => api<IngestResult>("/research/samples", { method: "POST" }), onSuccess: invalidate });
}

export function useAddDocument() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { title: string; text: string; source_name: string; published_at?: string; doc_type?: string; source_url?: string }) =>
      api<IngestResult>("/research/documents", { method: "POST", json: body }),
    onSuccess: invalidate,
  });
}

export function useUploadDocument() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { file: File; source_name: string; published_at?: string }) => {
      const form = new FormData();
      form.set("file", v.file);
      form.set("source_name", v.source_name);
      if (v.published_at) form.set("published_at", v.published_at);
      return api<IngestResult>("/research/documents/upload", { method: "POST", body: form });
    },
    onSuccess: invalidate,
  });
}

export function useDeleteDocument() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api(`/research/documents/${id}`, { method: "DELETE" }), onSuccess: invalidate });
}
