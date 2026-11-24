import { CheckCircle2, ChevronDown, ChevronRight, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { Fragment, useEffect, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { AutopilotPanel } from "@/features/risk/AutopilotPanel";
import {
  useKillSwitch, useResetDrawdown, useRiskDecisions, useRiskEvents, useRiskOverview, useUpdateLimits,
} from "@/features/risk/hooks";
import { useAccountParam } from "@/features/trading/useAccountParam";
import { cn, formatDateTime, formatMoney } from "@/lib/utils";
import type { RiskCheck, RiskLimits, RiskOverview } from "@/services/api";

const LIMIT_META: { key: keyof RiskLimits; label: string; unit: string }[] = [
  { key: "risk_per_trade_pct", label: "Risk per trade", unit: "% equity" },
  { key: "max_position_pct", label: "Max position size", unit: "% equity" },
  { key: "max_gross_exposure_pct", label: "Max gross exposure", unit: "% equity" },
  { key: "max_open_positions", label: "Max open positions", unit: "positions" },
  { key: "daily_loss_limit_pct", label: "Daily loss limit", unit: "% day start" },
  { key: "max_drawdown_pct", label: "Max drawdown", unit: "% from peak" },
  { key: "max_orders_per_minute", label: "Max order rate", unit: "per minute" },
  { key: "price_collar_pct", label: "Price collar", unit: "% through market" },
];

function Meter({ label, value, limit, display, testid }: { label: string; value: number; limit: number; display: string; testid: string }) {
  const used = limit > 0 ? Math.min(100, (value / limit) * 100) : 0;
  const tone = used >= 100 ? "bg-negative" : used >= 75 ? "bg-warning" : "bg-positive";
  return (
    <div className="rounded-lg border border-border bg-surface p-4" data-testid={testid}>
      <div className="flex items-baseline justify-between text-xs"><span className="font-medium uppercase tracking-wider text-muted">{label}</span>
        <span className="num text-subtle">limit {limit}{label === "Open positions" ? "" : "%"}</span></div>
      <div className="num mt-2 text-lg font-semibold">{display}</div>
      <div className="mt-2 h-1.5 rounded bg-surface-3" role="meter" aria-label={label} aria-valuenow={Math.round(used)} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn("h-full rounded", tone)} style={{ width: `${used}%` }} />
      </div>
      <div className="mt-1 text-[11px] text-subtle">{used.toFixed(0)}% of limit used</div>
    </div>
  );
}

function Controls({ ov }: { ov: RiskOverview }) {
  const kill = useKillSwitch(ov.account_id);
  const reset = useResetDrawdown(ov.account_id);
  const [reason, setReason] = useState("");
  const s = ov.state;
  return (
    <Card>
      <CardHeader title="Kill switch and breakers" description="Halts block new exposure. Exits and protective stops always work." />
      <CardBody className="space-y-4">
        <ErrorBanner error={kill.error ?? reset.error} />
        <div className="flex items-center justify-between gap-3">
          <div><div className="text-sm font-medium">Account kill switch</div>
            <div className="text-xs text-muted">{s.kill_switch ? `Engaged ${s.kill_engaged_at ? formatDateTime(s.kill_engaged_at) : ""}: ${s.kill_reason}` : "Off"}</div></div>
          {s.kill_switch
            ? <Button size="sm" variant="secondary" onClick={() => kill.mutate({ engaged: false })} disabled={kill.isPending}><ShieldCheck />Release</Button>
            : <Button size="sm" variant="danger" onClick={() => { kill.mutate({ engaged: true, reason: reason || undefined }); setReason(""); }} disabled={kill.isPending}><ShieldOff />Engage</Button>}
        </div>
        {!s.kill_switch && <Input aria-label="Kill switch reason" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}
        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <div><div className="text-sm font-medium">Daily loss breaker</div>
            <div className="text-xs text-muted">{s.daily_halted ? "Tripped: resets automatically at 00:00 UTC" : `Armed at ${ov.limits.daily_loss_limit_pct}%`}</div></div>
          <Badge tone={s.daily_halted ? "negative" : "positive"}>{s.daily_halted ? "Tripped" : "Armed"}</Badge>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <div><div className="text-sm font-medium">Drawdown breaker</div>
            <div className="text-xs text-muted">{s.drawdown_halted ? "Tripped: review, then reset (the peak is re-based)" : `Armed at ${ov.limits.max_drawdown_pct}% from peak`}</div></div>
          {s.drawdown_halted
            ? <Button size="sm" variant="secondary" onClick={() => reset.mutate(undefined)} disabled={reset.isPending}>Reset breaker</Button>
            : <Badge tone="positive">Armed</Badge>}
        </div>
      </CardBody>
    </Card>
  );
}

function LimitsForm({ ov }: { ov: RiskOverview }) {
  const update = useUpdateLimits(ov.account_id);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => { setDraft({}); }, [ov.account_id]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const changes = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== "").map(([k, v]) => [k, Number(v)]));
    await update.mutateAsync(changes);
    setDraft({}); setSaved(true);
  }
  return (
    <Card>
      <CardHeader title="Limits" description="Tighten freely; loosening is capped by platform ceilings and recorded" />
      <CardBody>
        <form onSubmit={submit} className="space-y-3" onChange={() => setSaved(false)}>
          <ErrorBanner error={update.error} />
          <div className="grid grid-cols-2 gap-3">
            {LIMIT_META.map((m) => (
              <Field key={m.key} label={m.label} htmlFor={`lim-${m.key}`} hint={`${m.unit} · default ${ov.defaults[m.key]}, max ${ov.ceilings[m.key]}`}>
                <Input id={`lim-${m.key}`} inputMode="decimal" className="num" value={draft[m.key] ?? String(ov.limits[m.key])}
                  onChange={(e) => setDraft({ ...draft, [m.key]: e.target.value })} />
              </Field>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={update.isPending || Object.keys(draft).length === 0}>Save limits</Button>
            {saved && <span className="flex items-center gap-1 text-xs text-positive"><CheckCircle2 className="size-3.5" />Saved</span>}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

/** The checks the risk gate ran, failed ones first. */
export function ChecksList({ checks, compact = false }: { checks: RiskCheck[]; compact?: boolean }) {
  const sorted = [...checks].sort((a, b) => Number(a.passed) - Number(b.passed));
  return (
    <ul className={cn("grid gap-1 text-[11px]", !compact && "sm:grid-cols-2")} data-testid="risk-checks">
      {sorted.map((c) => (
        <li key={c.name} className="flex items-center justify-between gap-3 rounded border border-border bg-surface-2 px-2 py-1" title={c.message || undefined}>
          <span className={cn("flex shrink-0 items-center gap-1.5", c.passed ? "text-muted" : "text-negative")}>
            <span className={cn("size-1.5 shrink-0 rounded-full", c.passed ? "bg-positive" : "bg-negative")} />{c.label}</span>
          <span className="num min-w-0 truncate text-right text-subtle">{c.value} <span className="text-subtle/70">· limit {c.limit}</span></span>
        </li>
      ))}
    </ul>
  );
}

function Decisions({ accountId }: { accountId: string }) {
  const [filter, setFilter] = useState<"" | "true" | "false">("");
  const decisions = useRiskDecisions(accountId, filter === "" ? undefined : filter === "true");
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Pre-trade decisions" description="Every order, manual or AI, with every check the gate ran"
        action={<Select aria-label="Decision filter" className="h-8 w-32 text-xs" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="">All</option><option value="true">Approved</option><option value="false">Rejected</option></Select>} />
      {(decisions.data?.items.length ?? 0) === 0 ? <EmptyState title="No decisions yet">They appear as soon as you place an order.</EmptyState> : (
        <Table>
          <thead><tr><Th /><Th>Time</Th><Th>Source</Th><Th>Order</Th><Th>Decision</Th><Th>Reason</Th></tr></thead>
          <tbody>
            {decisions.data!.items.map((d) => (
              <Fragment key={d.id}>
                <Tr className="cursor-pointer" onClick={() => setOpen(open === d.id ? null : d.id)}>
                  <Td>{open === d.id ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</Td>
                  <Td className="num whitespace-nowrap text-xs text-muted">{formatDateTime(d.created_at)}</Td>
                  <Td><Badge tone={d.source === "manual" ? "neutral" : "info"}>{d.source}</Badge></Td>
                  <Td className="text-sm"><span className={d.side === "BUY" ? "text-positive" : "text-negative"}>{d.side}</span> {d.symbol}</Td>
                  <Td><Badge tone={d.approved ? "positive" : "negative"}>{d.approved ? "Approved" : "Rejected"}</Badge></Td>
                  <Td className="max-w-[360px] truncate text-xs text-muted" title={d.reason ?? undefined}>{d.reason ?? "—"}</Td>
                </Tr>
                {open === d.id && <tr><td colSpan={6} className="px-4 pb-3"><ChecksList checks={d.checks} /></td></tr>}
              </Fragment>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Events({ accountId }: { accountId: string }) {
  const events = useRiskEvents(accountId);
  const items = events.data?.items ?? [];
  return (
    <Card>
      <CardHeader title="Risk events" description="Breakers, kill switches, limit changes and autopilot activity" />
      {items.length === 0 ? <EmptyState title="No risk events" /> : (
        <ol className="max-h-[420px] divide-y divide-border/60 overflow-y-auto" data-testid="risk-events">
          {items.map((e) => (
            <li key={e.id} className="px-5 py-2.5">
              <div className="flex items-center justify-between gap-2"><Badge tone={/BREAKER|KILL_SWITCH_ON|ABNORMAL|EMERGENCY|SYSTEM_HALT/.test(e.type) && e.type !== "BREAKER_RESET" ? "negative" : "neutral"}>{e.type.replaceAll("_", " ")}</Badge>
                <span className="num text-[11px] text-subtle">{formatDateTime(e.created_at)}</span></div>
              <p className="mt-1 text-sm">{e.message}</p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

export function RiskPage() {
  const { accounts, list, account, select } = useAccountParam();
  const ov = useRiskOverview(account?.id);
  if (accounts.isLoading) return <Spinner className="mx-auto mt-16" />;
  if (!account) return <Card><EmptyState icon={<ShieldAlert />} title="No paper accounts">Create a paper account to configure its risk limits.</EmptyState></Card>;
  const o = ov.data;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-72">
          <Field label="Paper account" htmlFor="rk-acct">
            <Select id="rk-acct" value={account.id} onChange={(e) => select(e.target.value)}>
              {list.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.base_currency}</option>)}
            </Select>
          </Field>
        </div>
      </div>
      <ErrorBanner error={ov.error} />
      {!o ? <Spinner className="mx-auto" /> : (
        <>
          <div data-testid="risk-status" className={cn("flex items-start gap-3 rounded-lg border px-4 py-3 text-sm",
            o.state.blocked_reason ? "border-negative/40 bg-negative/10 text-negative" : "border-positive/40 bg-positive/10 text-positive")}>
            {o.state.blocked_reason ? <ShieldOff className="mt-0.5 size-4 shrink-0" /> : <ShieldCheck className="mt-0.5 size-4 shrink-0" />}
            <span>{o.state.blocked_reason ? <>New exposure is blocked: {o.state.blocked_reason}. Exits and protective stops still work.</>
              : <>Trading allowed. Every order, manual or AI, passes the risk gate before it reaches the order book.</>}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <Meter testid="meter-daily" label="Daily loss" value={o.metrics.daily_loss_pct} limit={o.limits.daily_loss_limit_pct}
              display={`${o.metrics.daily_loss_pct.toFixed(2)}% · ${formatMoney(o.metrics.daily_pnl, o.currency)}`} />
            <Meter testid="meter-drawdown" label="Drawdown" value={o.metrics.drawdown_pct} limit={o.limits.max_drawdown_pct} display={`${o.metrics.drawdown_pct.toFixed(2)}%`} />
            <Meter testid="meter-exposure" label="Gross exposure" value={o.metrics.exposure_pct} limit={o.limits.max_gross_exposure_pct} display={`${o.metrics.exposure_pct.toFixed(1)}%`} />
            <Meter testid="meter-position" label="Largest position" value={o.metrics.largest_position_pct} limit={o.limits.max_position_pct} display={`${o.metrics.largest_position_pct.toFixed(1)}%`} />
            <Meter testid="meter-positions" label="Open positions" value={o.metrics.open_positions} limit={o.limits.max_open_positions} display={`${o.metrics.open_positions}`} />
          </div>
          <div className="grid gap-6 xl:grid-cols-3">
            <Controls ov={o} />
            <AutopilotPanel accountId={account.id} />
            <LimitsForm ov={o} />
          </div>
          <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
            <Decisions accountId={account.id} />
            <Events accountId={account.id} />
          </div>
        </>
      )}
    </div>
  );
}
