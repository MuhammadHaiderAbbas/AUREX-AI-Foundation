import { Bot, Pause, Play, Power, Settings2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { useAccounts } from "@/features/accounts/hooks";
import { useAgents, useProposals, useRun, useRunAnalysis, useRuns, useUpdateAgent } from "@/features/ai/hooks";
import { ProposalCard, RunView } from "@/features/ai/RunView";
import { useAuth } from "@/features/auth/AuthProvider";
import { useMarketOverview } from "@/features/markets/hooks";
import { cn, relativeTime } from "@/lib/utils";

function ExecutionControls() {
  return (
    <Card>
      <CardHeader title="Autonomous execution" description="Paper order execution arrives in Phase 8; the independent risk gate in Phase 9" />
      <CardBody className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral"><Power className="size-3" />Execution disabled</Badge>
        <Button size="sm" variant="secondary" disabled title="Available in Phase 8"><Play />Start</Button>
        <Button size="sm" variant="secondary" disabled title="Available in Phase 8"><Pause />Pause</Button>
        <Button size="sm" variant="danger" disabled title="Available in Phase 9">Emergency stop</Button>
      </CardBody>
    </Card>
  );
}

function RunPanel({ onRun }: { onRun: (id: string) => void }) {
  const overview = useMarketOverview();
  const accounts = useAccounts();
  const run = useRunAnalysis();
  const [params] = useSearchParams();
  const [symbol, setSymbol] = useState(params.get("symbol") ?? "BTC-USD");
  const [account, setAccount] = useState("");
  const instruments = Object.values(overview.data?.groups ?? {}).flat().map((g) => g.instrument);
  useEffect(() => { if (!account && accounts.data?.[0]) setAccount(accounts.data[0].id); }, [accounts.data, account]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await run.mutateAsync({ symbol, account_id: account || undefined });
    onRun(r.id);
  }
  return (
    <Card>
      <CardHeader title="Run the agent department" description="Eight specialists analyse one instrument; the orchestrator decides" />
      <CardBody>
        <form onSubmit={submit} className="space-y-3">
          <ErrorBanner error={run.error} />
          <Field label="Instrument" htmlFor="ai-sym">
            <Select id="ai-sym" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {instruments.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol} · {i.display_name}</option>)}
            </Select>
          </Field>
          <Field label="Paper account (for sizing)" htmlFor="ai-acct" hint={accounts.data?.length ? undefined : "No paper account: the portfolio agent will abstain."}>
            <Select id="ai-acct" value={account} onChange={(e) => setAccount(e.target.value)}>
              {(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name} · {a.base_currency}</option>)}
              {!accounts.data?.length && <option value="">None</option>}
            </Select>
          </Field>
          <Button type="submit" className="w-full" disabled={run.isPending}>{run.isPending ? <Spinner className="text-accent-fg" /> : <Bot />}Run analysis</Button>
        </form>
      </CardBody>
    </Card>
  );
}

function RunHistory({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const runs = useRuns();
  const items = runs.data?.items ?? [];
  return (
    <Card>
      <CardHeader title="Activity timeline" description="Every run is stored with its evidence" />
      {items.length === 0 ? <EmptyState title="No runs yet" /> : (
        <ol className="max-h-[380px] divide-y divide-border/60 overflow-y-auto">
          {items.map((r) => (
            <li key={r.id}>
              <button onClick={() => onSelect(r.id)} className={cn("flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2", selected === r.id && "bg-surface-3")}>
                <span className={cn("size-2 shrink-0 rounded-full", r.decision === "BUY" ? "bg-positive" : "bg-subtle")} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{r.symbol} · <span className={r.decision === "BUY" ? "text-positive" : "text-muted"}>{r.decision === "BUY" ? "BUY" : "No trade"}</span></span>
                  <span className="block text-[11px] text-subtle">{relativeTime(r.created_at)} · {r.bias} · net {r.net_score >= 0 ? "+" : ""}{r.net_score.toFixed(2)}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function AgentConfig() {
  const agents = useAgents();
  const update = useUpdateAgent();
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const [weights, setWeights] = useState<Record<string, string>>({});
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Settings2 className="size-4" />Agent registry</span>}
        description={admin ? "Gates cannot be disabled. Weights apply to the consensus vote." : "Configured by administrators"} />
      <ErrorBanner error={update.error} className="m-4" />
      {agents.isLoading ? <div className="p-6"><Spinner /></div> : (
        <Table>
          <thead><tr><Th>Agent</Th><Th>Role</Th><Th>Kind</Th><Th className="text-right">Weight</Th><Th>Status</Th></tr></thead>
          <tbody>
            {agents.data?.map((a) => (
              <Tr key={a.name}>
                <Td className="whitespace-nowrap font-medium">{a.display_name}<div className="text-[11px] font-normal text-subtle">v{a.version}</div></Td>
                <Td className="text-xs text-muted">{a.role}</Td>
                <Td><Badge tone={a.kind === "gate" ? "info" : "neutral"}>{a.kind}</Badge></Td>
                <Td className="text-right">
                  {admin && a.kind === "directional" ? (
                    <Input aria-label={`${a.display_name} weight`} className="num ml-auto h-8 w-20 text-right" inputMode="decimal"
                      value={weights[a.name] ?? a.weight.toFixed(2)} onChange={(e) => setWeights({ ...weights, [a.name]: e.target.value })}
                      onBlur={(e) => { const w = Number(e.target.value); if (!Number.isNaN(w) && w !== a.weight) update.mutate({ name: a.name, weight: w }); }} />
                  ) : <span className="num text-xs">{a.kind === "gate" ? "—" : a.weight.toFixed(2)}</span>}
                </Td>
                <Td>
                  {admin && a.kind === "directional" ? (
                    <button onClick={() => update.mutate({ name: a.name, enabled: !a.enabled })} aria-pressed={a.enabled} aria-label={`Toggle ${a.display_name}`}>
                      <Badge tone={a.enabled ? "positive" : "neutral"}>{a.enabled ? "Enabled" : "Disabled"}</Badge>
                    </button>
                  ) : <Badge tone={a.enabled ? "positive" : "neutral"}>{a.enabled ? "Enabled" : "Disabled"}</Badge>}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function ProposalsTab() {
  const proposals = useProposals();
  const items = proposals.data?.items ?? [];
  return items.length === 0
    ? <Card><EmptyState icon={<Bot />} title="No trade proposals yet">Proposals appear when the agents reach a BUY consensus that passes every gate.</EmptyState></Card>
    : <div className="space-y-4">{items.map((p) => <ProposalCard key={p.id} p={p} />)}</div>;
}

export function AITradingPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "desk";
  const selected = params.get("run");
  const run = useRun(selected);
  const select = (id: string) => setParams({ tab: "desk", run: id });
  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-md bg-surface p-1" role="tablist" style={{ width: "fit-content" }}>
        {[["desk", "Agent desk"], ["proposals", "Proposals"], ["agents", "Agents"]].map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setParams({ tab: k! })}
            className={cn("rounded px-4 py-1.5 text-sm", tab === k ? "bg-surface-3 text-fg" : "text-muted hover:text-fg")}>{label}</button>
        ))}
      </div>
      {tab === "desk" && (
        <div className="grid gap-4 xl:grid-cols-[340px_1fr]">
          <div className="space-y-4"><RunPanel onRun={select} /><ExecutionControls /><RunHistory selected={selected} onSelect={select} /></div>
          <div className="min-w-0">
            {run.data ? <RunView run={run.data} /> : run.isLoading ? <Spinner className="mx-auto mt-16" /> : (
              <Card><EmptyState icon={<Bot />} title="Run an analysis to see the agents' evidence">
                The orchestrator returns NO TRADE unless the evidence is strong, consistent and every gate passes.
              </EmptyState></Card>
            )}
          </div>
        </div>
      )}
      {tab === "proposals" && <ProposalsTab />}
      {tab === "agents" && <AgentConfig />}
    </div>
  );
}
