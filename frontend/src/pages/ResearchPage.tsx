import { BrainCircuit, Database, FileUp, Library, Plus, Search, Send, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState, ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { useAuth } from "@/features/auth/AuthProvider";
import { useMarketOverview } from "@/features/markets/hooks";
import { docTypeLabel, engineLabel, ReportView } from "@/features/research/ReportView";
import {
  useAddDocument, useAsk, useDeleteDocument, useDocuments, useLoadSamples, useReport, useReports,
  useResearchStatus, useSearch, useUploadDocument,
} from "@/features/research/hooks";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";
import { isDemo } from "@/services/api";

const SUGGESTIONS = [
  "What is the outlook for Northwind Robotics margins and inventory?",
  "What did the central bank decide on the policy rate and why?",
  "Is the labour market cooling?",
  "What are the risks for EUR/USD?",
];
const DOC_TYPES = ["earnings", "filing", "central_bank", "economic_data", "news", "analysis", "other"];

function AskPanel({ onReport }: { onReport: (id: string) => void }) {
  const ask = useAsk();
  const overview = useMarketOverview();
  const [question, setQuestion] = useState("");
  const [symbols, setSymbols] = useState<string[]>([]);
  const [maxAge, setMaxAge] = useState("");
  const instruments = Object.values(overview.data?.groups ?? {}).flat().map((g) => g.instrument.symbol);

  async function submit(e?: FormEvent, q = question) {
    e?.preventDefault();
    if (q.trim().length < 3) return;
    const r = await ask.mutateAsync({ question: q.trim(), symbols, max_age_days: maxAge ? +maxAge : undefined });
    onReport(r.id);
  }

  return (
    <Card>
      <CardHeader title="Ask the research desk" description="Answers cite the research corpus and separate facts from interpretation" />
      <CardBody>
        <form onSubmit={submit} className="space-y-3">
          <ErrorBanner error={ask.error} />
          <label htmlFor="question" className="sr-only">Research question</label>
          <textarea id="question" rows={3} maxLength={1000} value={question} onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. What economic events could affect GBP/USD?"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
            className="w-full resize-y rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-sm placeholder:text-subtle focus:border-accent focus:outline-none" />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Instrument filter" htmlFor="sym">
              <Select id="sym" value="" onChange={(e) => e.target.value && !symbols.includes(e.target.value) && setSymbols([...symbols, e.target.value])}>
                <option value="">Any instrument</option>
                {instruments.map((s) => <option key={s}>{s}</option>)}
              </Select>
            </Field>
            <Field label="Evidence age" htmlFor="age">
              <Select id="age" value={maxAge} onChange={(e) => setMaxAge(e.target.value)}>
                <option value="">Any age</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option><option value="365">Last year</option>
              </Select>
            </Field>
          </div>
          {symbols.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {symbols.map((s) => (
                <button key={s} type="button" onClick={() => setSymbols(symbols.filter((x) => x !== s))} aria-label={`Remove ${s} filter`}>
                  <Badge tone="info">{s} ×</Badge>
                </button>
              ))}
            </div>
          )}
          <Button type="submit" className="w-full" disabled={ask.isPending || question.trim().length < 3}>
            {ask.isPending ? <Spinner className="text-accent-fg" /> : <Send />}Research
          </Button>
        </form>
        <div className="mt-4 space-y-1.5">
          <p className="text-[11px] uppercase tracking-wider text-subtle">Try</p>
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => { setQuestion(s); submit(undefined, s); }} disabled={ask.isPending}
              className="block w-full rounded px-2 py-1.5 text-left text-xs text-muted hover:bg-surface-2 hover:text-fg">{s}</button>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

function History({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const reports = useReports();
  const items = reports.data?.items ?? [];
  return (
    <Card>
      <CardHeader title="Recent reports" />
      {items.length === 0 ? <EmptyState title="No reports yet" /> : (
        <ul className="max-h-[360px] divide-y divide-border/60 overflow-y-auto">
          {items.map((r) => (
            <li key={r.id}>
              <button onClick={() => onSelect(r.id)} className={cn("w-full px-4 py-2.5 text-left hover:bg-surface-2", selected === r.id && "bg-surface-3")}>
                <p className="line-clamp-2 text-sm">{r.question}</p>
                <p className="mt-0.5 text-[11px] text-subtle">
                  {relativeTime(r.created_at)} · {r.insufficient_evidence ? "insufficient evidence" : `confidence ${r.confidence.toFixed(2)}`}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AskTab() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("report");
  const report = useReport(selected);
  const select = (id: string) => setParams({ tab: "ask", report: id });
  return (
    <div className="grid gap-4 xl:grid-cols-[380px_1fr]">
      <div className="space-y-4"><AskPanel onReport={select} /><History selected={selected} onSelect={select} /></div>
      <div className="min-w-0">
        {report.data ? <ReportView report={report.data} /> : report.isLoading ? <Spinner className="mx-auto mt-16" /> : (
          <Card><EmptyState icon={<BrainCircuit />} title="Ask a question to generate a research report">
            Reports cite specific passages, flag stale or conflicting sources, and never place trades.
          </EmptyState></Card>
        )}
      </div>
    </div>
  );
}

function AddDocumentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const add = useAddDocument();
  const upload = useUploadDocument();
  const [mode, setMode] = useState<"paste" | "file">("paste");
  const [form, setForm] = useState({ title: "", text: "", source_name: "", published: "", doc_type: "" });
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const published_at = form.published ? new Date(form.published).toISOString() : undefined;
    const r = mode === "paste"
      ? await add.mutateAsync({ title: form.title, text: form.text, source_name: form.source_name, published_at, doc_type: form.doc_type || undefined })
      : await upload.mutateAsync({ file: file!, source_name: form.source_name, published_at });
    setResult(r.created ? `Indexed “${r.documents[0]?.title}”` : "Already in the corpus (duplicate content)");
  }
  const err = add.error ?? upload.error;
  const busy = add.isPending || upload.isPending;
  return (
    <Dialog open={open} onClose={() => { setResult(null); add.reset(); upload.reset(); onClose(); }} title="Add research document">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-1 rounded-md bg-surface-2 p-1" role="tablist">
          {(["paste", "file"] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
              className={cn("rounded px-3 py-1.5 text-xs font-medium", mode === m ? "bg-surface-3 text-fg" : "text-muted")}>
              {m === "paste" ? "Paste text" : isDemo ? "Upload .txt / .html" : "Upload PDF / HTML / text"}
            </button>
          ))}
        </div>
        <ErrorBanner error={err} />
        {result && <p className="text-sm text-positive">{result}</p>}
        {mode === "paste" ? (
          <>
            <Field label="Title" htmlFor="d-title"><Input id="d-title" required maxLength={300} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
            <Field label="Text" htmlFor="d-text">
              <textarea id="d-text" required rows={6} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })}
                className="w-full rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-sm focus:border-accent focus:outline-none" />
            </Field>
          </>
        ) : (
          <Field label="File" htmlFor="d-file" hint="Max 10 MB. Scanned PDFs need OCR (not yet supported).">
            <input id="d-file" type="file" required accept={isDemo ? ".txt,.md,.html,.htm" : ".pdf,.txt,.md,.html,.htm"}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-xs text-muted file:mr-3 file:rounded file:border-0 file:bg-surface-3 file:px-3 file:py-1.5 file:text-fg" />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Source" htmlFor="d-src"><Input id="d-src" required maxLength={120} placeholder="Publisher" value={form.source_name} onChange={(e) => setForm({ ...form, source_name: e.target.value })} /></Field>
          <Field label="Published" htmlFor="d-pub"><Input id="d-pub" type="date" value={form.published} onChange={(e) => setForm({ ...form, published: e.target.value })} /></Field>
        </div>
        {mode === "paste" && (
          <Field label="Type" htmlFor="d-type" hint="Leave on auto-detect to classify from the content">
            <Select id="d-type" value={form.doc_type} onChange={(e) => setForm({ ...form, doc_type: e.target.value })}>
              <option value="">Auto-detect</option>{DOC_TYPES.map((t) => <option key={t} value={t}>{docTypeLabel(t)}</option>)}
            </Select>
          </Field>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
          <Button type="submit" disabled={busy}>{busy && <Spinner className="text-accent-fg" />}Index document</Button>
        </div>
      </form>
    </Dialog>
  );
}

function CorpusTab() {
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const [docType, setDocType] = useState("");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [adding, setAdding] = useState(false);
  const docs = useDocuments({ doc_type: docType });
  const search = useSearch(submitted);
  const samples = useLoadSamples();
  const del = useDeleteDocument();
  const items = docs.data?.items ?? [];

  return (
    <div className="space-y-4">
      <ErrorBanner error={docs.error ?? samples.error ?? del.error ?? search.error} />
      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><Search className="size-4" />Search the corpus</span>}
          description="Hybrid retrieval: vector similarity (pgvector) fused with full-text ranking" />
        <CardBody>
          <form onSubmit={(e) => { e.preventDefault(); setSubmitted(query); }} className="flex gap-2">
            <Input aria-label="Search query" placeholder="e.g. inventory risk" value={query} onChange={(e) => setQuery(e.target.value)} />
            <Button type="submit" variant="secondary">Search</Button>
          </form>
          {submitted && (
            <ul className="mt-3 divide-y divide-border/60">
              {search.isLoading && <li className="py-3"><Spinner /></li>}
              {search.data?.length === 0 && <li className="py-3 text-sm text-muted">No matching passages.</li>}
              {search.data?.map((h) => (
                <li key={h.chunk_id} className="py-3">
                  <p className="text-sm font-medium">{h.document.title}</p>
                  <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted">{h.text}</p>
                  <p className="mt-1 text-[11px] text-subtle">score {h.score.toFixed(1)}{h.page != null && ` · p.${h.page}`} · ¶{h.paragraph}{h.stale && " · stale"}</p>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><Library className="size-4" />Documents</span>}
          description={`${docs.data?.total ?? 0} indexed`}
          action={admin && (
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => samples.mutate()} disabled={samples.isPending}><Database />Load sample corpus</Button>
              <Button size="sm" onClick={() => setAdding(true)}><Plus />Add document</Button>
            </div>
          )} />
        <div className="border-b border-border px-5 py-2.5">
          <Select aria-label="Filter by type" className="w-48" value={docType} onChange={(e) => setDocType(e.target.value)}>
            <option value="">All types</option>{DOC_TYPES.map((t) => <option key={t} value={t}>{docTypeLabel(t)}</option>)}
          </Select>
        </div>
        {docs.isLoading ? <div className="p-8"><Spinner className="mx-auto" /></div> : items.length === 0 ? (
          <EmptyState icon={<FileUp />} title="The research corpus is empty">
            {admin ? "Load the fictional sample corpus or add your own documents." : "An administrator needs to add documents."}
          </EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Document</Th><Th>Type</Th><Th>Instruments</Th><Th>Published</Th><Th className="text-right">Words</Th>{admin && <Th />}</tr></thead>
            <tbody>
              {items.map((d) => (
                <Tr key={d.id}>
                  <Td><div className="font-medium">{d.title}</div>
                    <div className="flex items-center gap-2 text-[11px] text-subtle">{d.source_name}{d.is_sample && <Badge tone="warning">Fictional sample</Badge>}</div></Td>
                  <Td><Badge>{docTypeLabel(d.doc_type)}</Badge></Td>
                  <Td>{d.symbols.length ? d.symbols.map((s) => <Badge key={s} tone="info" className="mr-1">{s}</Badge>) : <span className="text-subtle">—</span>}</Td>
                  <Td className="num whitespace-nowrap text-xs text-muted">{d.published_at ? formatDateTime(d.published_at) : "—"}</Td>
                  <Td className="num text-right text-xs">{d.word_count}</Td>
                  {admin && <Td className="text-right">
                    <button aria-label={`Delete ${d.title}`} className="text-subtle hover:text-negative" onClick={() => { if (confirm(`Delete “${d.title}”?`)) del.mutate(d.id); }}><Trash2 className="size-4" /></button>
                  </Td>}
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <AddDocumentDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

export function ResearchPage() {
  const status = useResearchStatus();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "corpus" ? "corpus" : "ask";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-md bg-surface p-1" role="tablist">
          {(["ask", "corpus"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setParams({ tab: t })}
              className={cn("rounded px-4 py-1.5 text-sm", tab === t ? "bg-surface-3 text-fg" : "text-muted hover:text-fg")}>
              {t === "ask" ? "Research" : "Corpus"}
            </button>
          ))}
        </div>
        {status.data && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <Badge tone={status.data.engine === "claude" ? "accent" : "neutral"}>
              {status.data.engine === "claude" ? engineLabel(`claude:${status.data.model}`) : "Offline extractive engine"}
            </Badge>
            <span>{status.data.documents} documents · {status.data.chunks} passages · {status.data.embedding_model}</span>
          </div>
        )}
      </div>
      {tab === "ask" ? <AskTab /> : <CorpusTab />}
    </div>
  );
}
