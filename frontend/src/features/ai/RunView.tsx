import { ArrowDownRight, ArrowRight, ArrowUpRight, Ban, CheckCircle2, ChevronDown, Clock, ShieldAlert, XCircle } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ErrorBanner, Spinner } from "@/components/ui/feedback";
import { cn, formatDateTime, formatMoney, formatPrice } from "@/lib/utils";
import type { AgentFinding, AgentRun, TradeProposal } from "@/services/api";
import { Link } from "react-router-dom";
import { useExecuteProposal } from "@/features/risk/hooks";
import { useDismissProposal } from "./hooks";

export const AGENT_LABEL: Record<string, string> = {
  technical: "Technical", quant: "Quant", regime: "Regime", fundamental: "Fundamental",
  news: "News", sentiment: "Sentiment", ml: "ML model", portfolio: "Portfolio", risk: "Risk (pre-check)",
};
const GATES = new Set(["regime", "portfolio", "risk"]);

function ScoreBar({ value, gate }: { value: number; gate?: boolean }) {
  if (gate) {
    return (
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
        <div className={cn("h-full rounded-full", value >= 0.5 ? "bg-positive" : value > 0 ? "bg-warning" : "bg-negative")} style={{ width: `${Math.max(4, value * 100)}%` }} />
      </div>
    );
  }
  const pct = Math.abs(value) * 50;
  return (
    <div className="relative h-1.5 w-full rounded-full bg-surface-3" aria-hidden>
      <div className="absolute inset-y-0 left-1/2 w-px bg-border-strong" />
      <div className={cn("absolute inset-y-0 rounded-full", value >= 0 ? "bg-positive" : "bg-negative")}
        style={value >= 0 ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${pct}%` }} />
    </div>
  );
}

function Direction({ d }: { d: number }) {
  if (d > 0) return <span className="flex items-center gap-1 text-xs text-positive"><ArrowUpRight className="size-3.5" />Bullish</span>;
  if (d < 0) return <span className="flex items-center gap-1 text-xs text-negative"><ArrowDownRight className="size-3.5" />Bearish</span>;
  return <span className="flex items-center gap-1 text-xs text-muted"><ArrowRight className="size-3.5" />Neutral</span>;
}

function AgentCard({ f, weight }: { f: AgentFinding; weight?: number }) {
  const [open, setOpen] = useState(false);
  const gate = GATES.has(f.agent);
  return (
    <div className={cn("flex flex-col rounded-lg border bg-surface p-4", f.status === "ok" ? "border-border" : "border-border/60 opacity-80")} data-testid={`agent-${f.agent}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{AGENT_LABEL[f.agent] ?? f.agent}</p>
          <p className="text-[11px] text-subtle">{gate ? "Gate" : `Vote weight ${((weight ?? 0) * 100).toFixed(0)}%`} · {f.duration_ms} ms</p>
        </div>
        {f.status === "ok" ? (gate
          ? <Badge tone={f.score >= 0.5 ? "positive" : "negative"}>{f.agent === "regime" ? (f.score > 0 ? "Open" : "Closed") : f.score >= 0.5 ? "Pass" : "Block"}</Badge>
          : <Direction d={f.direction} />)
          : <Badge tone={f.status === "error" ? "negative" : "neutral"}>{f.status === "error" ? "Error" : "Abstained"}</Badge>}
      </div>
      {f.status === "ok" && (
        <div className="mt-3 space-y-1">
          <ScoreBar value={f.score} gate={gate} />
          <div className="flex justify-between text-[11px] text-subtle">
            <span className="num">{gate ? `suitability ${f.score.toFixed(2)}` : `score ${f.score >= 0 ? "+" : ""}${f.score.toFixed(2)}`}</span>
            <span className="num">confidence {f.confidence.toFixed(2)}</span>
          </div>
        </div>
      )}
      <p className="mt-3 flex-1 text-xs leading-relaxed text-muted">{f.summary}</p>
      {f.evidence.length > 0 && (
        <>
          <button onClick={() => setOpen(!open)} className="mt-3 flex items-center gap-1 text-[11px] text-accent" aria-expanded={open}>
            <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />Evidence ({f.evidence.length})
          </button>
          {open && (
            <dl className="mt-2 space-y-1.5 border-t border-border pt-2">
              {f.evidence.map((e, i) => (
                <div key={i} className="text-[11px]">
                  <dt className="text-subtle">{e.label}</dt>
                  <dd className="num text-fg">{e.value}{e.detail && <span className="font-sans text-subtle"> · {e.detail}</span>}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = { PENDING_RISK_REVIEW: "Pending risk review", EXECUTED: "Executed", RISK_REJECTED: "Risk rejected", DISMISSED: "Dismissed", EXPIRED: "Expired" };

export function ProposalCard({ p }: { p: TradeProposal }) {
  const dismiss = useDismissProposal();
  const execute = useExecuteProposal();
  const [json, setJson] = useState(false);
  const pending = p.effective_status === "PENDING_RISK_REVIEW";
  // Price precision: the most significant decimals used by any of the three levels.
  const sig = (v: string) => (v.split(".")[1] ?? "").replace(/0+$/, "").length;
  const dp = Math.min(8, Math.max(2, sig(p.entry_price), sig(p.stop_loss), sig(p.take_profit)));
  const qty = Number(p.quantity).toLocaleString("en-GB", { maximumFractionDigits: 8 });
  const payload = {
    symbol: p.symbol, direction: p.direction, strategy_id: p.strategy_id, confidence: p.confidence,
    entry_type: p.entry_type, entry_price: +p.entry_price, stop_loss: +p.stop_loss, take_profit: +p.take_profit,
    quantity: +p.quantity, invalidation_conditions: p.invalidation_conditions, risk_check_required: p.risk_check_required,
  };
  return (
    <Card className={cn(pending && "border-accent/40")} data-testid="proposal">
      <CardHeader
        title={<span className="flex items-center gap-2">Trade proposal <Badge tone="positive">{p.direction} {p.symbol}</Badge></span>}
        description={`${p.strategy_id} · created ${formatDateTime(p.created_at)}`}
        action={<Badge tone={pending ? "warning" : p.effective_status === "EXECUTED" ? "positive" : p.effective_status === "RISK_REJECTED" ? "negative" : "neutral"}>
          {STATUS_LABEL[p.effective_status] ?? p.effective_status.toLowerCase()}</Badge>} />
      <CardBody className="space-y-4">
        <ErrorBanner error={dismiss.error ?? execute.error} />
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          {[
            ["Entry (limit)", formatPrice(p.entry_price, dp)], ["Stop loss", formatPrice(p.stop_loss, dp)],
            ["Take profit", formatPrice(p.take_profit, dp)], ["Reward : risk", `${p.reward_risk} : 1`],
            ["Quantity", qty], ["Notional", formatMoney(p.notional, p.account_currency)],
            ["Risk at stop", formatMoney(p.risk_amount, p.account_currency)], ["Confidence", `${p.confidence.toFixed(2)} (uncalibrated)`],
          ].map(([k, v]) => <div key={k}><dt className="text-[11px] text-subtle">{k}</dt><dd className="num">{v}</dd></div>)}
        </dl>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-subtle">Invalidation conditions</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted">{p.invalidation_conditions.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
        <div className="flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-accent" />
          <span data-testid="proposal-gate">
            {p.effective_status === "EXECUTED" ? <>Approved by the risk gate and executed as a paper market order with a protective stop and take-profit. {p.order_id && <Link className="text-accent hover:underline" to={`/history?account=${p.account_id}&order=${p.order_id}`}>View order</Link>}</>
              : p.effective_status === "RISK_REJECTED" ? <>Refused by the risk gate: {p.decision_reason}</>
              : <>Agents cannot place orders. Executing sends this proposal to the independent risk engine, which has the final say. {pending && <>Expires {formatDateTime(p.expires_at)}.</>}</>}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {pending && <Button size="sm" onClick={() => execute.mutate(p.id)} disabled={execute.isPending}><ShieldAlert />Send to risk gate</Button>}
          {pending && <Button size="sm" variant="outline" onClick={() => dismiss.mutate(p.id)} disabled={dismiss.isPending}><Ban />Dismiss</Button>}
          <Button size="sm" variant="ghost" onClick={() => setJson(!json)}>{json ? "Hide" : "View"} JSON</Button>
        </div>
        {json && <pre className="num overflow-x-auto rounded-md bg-bg p-3 text-[11px] leading-relaxed text-muted">{JSON.stringify(payload, null, 2)}</pre>}
      </CardBody>
    </Card>
  );
}

export function RunView({ run }: { run: AgentRun }) {
  const buy = run.decision === "BUY";
  const order = ["technical", "quant", "fundamental", "news", "sentiment", "ml", "regime", "portfolio", "risk"];
  const findings = [...run.findings].sort((a, b) => order.indexOf(a.agent) - order.indexOf(b.agent));
  return (
    <div className="space-y-4" aria-label="Agent run">
      <Card className={cn(buy ? "border-positive/40" : "border-border")}>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-subtle">Consensus decision · {run.symbol}</p>
              <p className={cn("mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight", buy ? "text-positive" : "text-fg")} data-testid="decision">
                {buy ? <CheckCircle2 className="size-6" /> : <XCircle className="size-6 text-muted" />}{buy ? "BUY" : "NO TRADE"}
              </p>
              <p className="mt-1 text-xs text-muted">Agent bias: <span className="capitalize">{run.bias}</span> · {formatDateTime(run.created_at)} · {run.latency_ms} ms</p>
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
              <div className="col-span-2 min-w-[180px] sm:col-span-1">
                <dt className="text-subtle">Net score</dt>
                <dd className="num mb-1">{run.net_score >= 0 ? "+" : ""}{run.net_score.toFixed(2)}</dd>
                <ScoreBar value={run.net_score} />
              </div>
              <div><dt className="text-subtle">Agreement</dt><dd className="num">{(run.agreement * 100).toFixed(0)}%</dd></div>
              <div><dt className="text-subtle">Coverage</dt><dd className="num">{(run.coverage * 100).toFixed(0)}%</dd></div>
              <div><dt className="text-subtle">Confidence</dt><dd className="num" title="Strength × agreement × coverage. Not a calibrated probability.">{run.confidence.toFixed(2)}*</dd></div>
            </dl>
          </div>
          {run.reasons.length > 0 && (
            <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wider text-subtle">Why no trade</p>
              <ul className="mt-1 space-y-0.5 text-sm">{run.reasons.map((r) => <li key={r} className="flex gap-2"><XCircle className="mt-0.5 size-3.5 shrink-0 text-negative" />{r}</li>)}</ul>
            </div>
          )}
          <p className="text-[11px] text-subtle">* Confidence values are heuristic and uncalibrated. Agents report evidence; they cannot place or approve orders.</p>
        </CardBody>
      </Card>
      {run.proposal && <ProposalCard p={run.proposal} />}
      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        {findings.map((f) => <AgentCard key={f.agent} f={f} weight={run.weights[f.agent]} />)}
      </div>
    </div>
  );
}

export function RunSpinner() {
  return <div className="flex items-center gap-2 text-sm text-muted"><Spinner /><Clock className="size-4" />Agents are analysing…</div>;
}
