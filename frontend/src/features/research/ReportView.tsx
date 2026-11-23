import { AlertTriangle, BookOpenCheck, CircleHelp, ExternalLink, FileText, Scale, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn, formatDateTime } from "@/lib/utils";
import type { ReportClaim, ResearchReport } from "@/services/api";

const DOC_TYPE_LABEL: Record<string, string> = {
  earnings: "Earnings", filing: "Filing", central_bank: "Central bank", economic_data: "Economic data",
  news: "News", analysis: "Analysis", other: "Other",
};
export const docTypeLabel = (t: string) => DOC_TYPE_LABEL[t] ?? t;

export function engineLabel(engine: string) {
  if (engine.startsWith("claude:")) return `Claude · ${engine.slice(7)}`;
  if (engine.startsWith("extractive")) return engine.includes("unavailable") ? "Offline engine (Claude unavailable)" : "Offline extractive engine";
  return engine;
}

function Cite({ n, onClick }: { n: number; onClick: (n: number) => void }) {
  return (
    <button onClick={() => onClick(n)} className="num ml-1 rounded bg-info/15 px-1.5 py-px text-[11px] font-semibold text-info hover:bg-info/25" aria-label={`Source ${n}`}>
      {n}
    </button>
  );
}

function Claims({ items, onCite, tone = "fact" }: { items: ReportClaim[]; onCite: (n: number) => void; tone?: "fact" | "contra" }) {
  return (
    <ol className="space-y-3">
      {items.map((c, i) => (
        <li key={i} className={cn("rounded-md border px-4 py-3", tone === "contra" ? "border-warning/30 bg-warning/5" : "border-border bg-surface-2")}>
          <p className="text-sm leading-relaxed">
            {c.statement}
            {c.citations.map((n) => <Cite key={n} n={n} onClick={onCite} />)}
          </p>
          {c.quote && c.quote !== c.statement && (
            <blockquote className="mt-2 border-l-2 border-border-strong pl-3 text-xs italic leading-relaxed text-muted">“{c.quote}”</blockquote>
          )}
        </li>
      ))}
    </ol>
  );
}

function ConfidenceMeter({ c }: { c: ResearchReport["body"]["confidence"] }) {
  const color = c.label === "high" ? "bg-positive" : c.label === "medium" ? "bg-warning" : "bg-negative";
  return (
    <div className="min-w-[200px]">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted">Evidence confidence</span>
        <span className="num font-semibold capitalize">{c.label} · {c.score.toFixed(2)}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3" role="meter" aria-valuenow={c.score} aria-valuemin={0} aria-valuemax={1} aria-label="Evidence confidence">
        <div className={cn("h-full rounded-full", color)} style={{ width: `${Math.round(c.score * 100)}%` }} />
      </div>
      <p className="mt-1 text-[10px] leading-snug text-subtle" title={c.method}>Heuristic, uncalibrated. Not a probability.</p>
    </div>
  );
}

export function ReportView({ report }: { report: ResearchReport }) {
  const b = report.body;
  const [open, setOpen] = useState<number | null>(null);
  const cite = (n: number) => {
    setOpen(n);
    document.getElementById(`source-${report.id}-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const cited = new Set([...b.facts, ...b.contradictions].flatMap((f) => f.citations));

  return (
    <article className="space-y-4" aria-label="Research report">
      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-wider text-subtle">Research question</p>
              <h2 className="mt-1 text-lg font-semibold leading-snug">{b.question}</h2>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                <Badge tone={b.engine.startsWith("claude:") ? "accent" : "neutral"}><Sparkles className="size-3" />{engineLabel(b.engine)}</Badge>
                <span>{formatDateTime(b.generated_at)}</span>
                <span>· {report.latency_ms} ms</span>
                {report.symbols.map((s) => <Badge key={s} tone="info">{s}</Badge>)}
              </div>
            </div>
            <ConfidenceMeter c={b.confidence} />
          </div>
          {b.warnings.length > 0 && (
            <ul className="space-y-1 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {b.warnings.map((w) => <li key={w} className="flex gap-2"><AlertTriangle className="mt-px size-3.5 shrink-0" />{w}</li>)}
            </ul>
          )}
        </CardBody>
      </Card>

      {b.insufficient_evidence ? (
        <Card>
          <CardBody className="flex gap-3 text-sm">
            <CircleHelp className="mt-0.5 size-5 shrink-0 text-subtle" />
            <div>
              <p className="font-medium">Insufficient evidence</p>
              <p className="mt-1 text-muted">The research corpus does not contain passages that answer this question, so no answer was produced. Add relevant documents or rephrase the question.</p>
              {b.open_questions.length > 0 && <ul className="mt-2 list-disc pl-5 text-muted">{b.open_questions.map((q) => <li key={q}>{q}</li>)}</ul>}
            </div>
          </CardBody>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader title={<span className="flex items-center gap-2"><BookOpenCheck className="size-4 text-positive" />Verified facts</span>}
              description="Each fact is quoted from, and checked against, the cited source text" />
            <CardBody><Claims items={b.facts} onCite={cite} /></CardBody>
          </Card>

          {b.interpretation && (
            <Card className="border-accent/30">
              <CardHeader title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-accent" />{b.interpretation.label}</span>}
                description="Not verified fact. Read together with the cited evidence" />
              <CardBody><p className="text-sm leading-relaxed">{b.interpretation.text}</p></CardBody>
            </Card>
          )}

          {b.contradictions.length > 0 && (
            <Card>
              <CardHeader title={<span className="flex items-center gap-2"><Scale className="size-4 text-warning" />Contradictory evidence</span>} />
              <CardBody><Claims items={b.contradictions} onCite={cite} tone="contra" /></CardBody>
            </Card>
          )}

          {b.open_questions.length > 0 && (
            <Card>
              <CardHeader title="Open questions" />
              <CardBody><ul className="list-disc space-y-1 pl-5 text-sm text-muted">{b.open_questions.map((q) => <li key={q}>{q}</li>)}</ul></CardBody>
            </Card>
          )}
        </>
      )}

      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><FileText className="size-4" />Sources</span>}
          description={`${b.sources.length} retrieved · ${cited.size} cited · ${b.validation.claims_verified}/${b.validation.claims_proposed} claims verified`} />
        <ol className="divide-y divide-border/60">
          {b.sources.map((s) => (
            <li key={s.n} id={`source-${report.id}-${s.n}`} className={cn("px-5 py-3", open === s.n && "bg-surface-2")}>
              <button className="flex w-full items-start gap-3 text-left" onClick={() => setOpen(open === s.n ? null : s.n)} aria-expanded={open === s.n}>
                <span className={cn("num mt-0.5 rounded px-1.5 py-px text-[11px] font-semibold", cited.has(s.n) ? "bg-info/15 text-info" : "bg-surface-3 text-subtle")}>{s.n}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{s.title}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-subtle">
                    <span>{s.source_name}</span>
                    <span>· {docTypeLabel(s.doc_type)}</span>
                    <span>· published {s.published_at ? formatDateTime(s.published_at) : "unknown"}</span>
                    <span>· retrieved {formatDateTime(s.retrieved_at)}</span>
                    {s.page != null && <span>· p.{s.page}</span>}
                    <span>· ¶{s.paragraph}</span>
                    {s.stale && <Badge tone="warning" title={`Older than ${s.stale_after_days} days for this document type`}>Stale · {s.age_days}d</Badge>}
                    {s.is_sample && <Badge tone="warning">Fictional sample</Badge>}
                  </span>
                </span>
              </button>
              {open === s.n && (
                <div className="mt-2 ml-9 space-y-2">
                  <p className="whitespace-pre-line rounded-md bg-bg px-3 py-2 text-xs leading-relaxed text-muted">{s.excerpt}</p>
                  {s.source_url && (
                    <a href={s.source_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                      Open original <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      </Card>

      {b.validation.rejected.length > 0 && (
        <Card>
          <CardHeader title="Removed by citation verification" description="Claims the engine proposed whose quotes could not be found in the cited sources" />
          <CardBody>
            <ul className="space-y-1 text-xs text-muted">{b.validation.rejected.map((r, i) => <li key={i}><span className="line-through">{r.statement}</span> · {r.reason}</li>)}</ul>
          </CardBody>
        </Card>
      )}
      <p className="flex items-center gap-2 px-1 text-[11px] text-subtle"><ShieldCheck className="size-3.5" />{b.disclaimer}</p>
    </article>
  );
}
