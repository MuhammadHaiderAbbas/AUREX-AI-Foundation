import { History, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Select } from "@/components/ui/form";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { useCancelOrder, useExecutions, useOrder, useOrders } from "@/features/trading/hooks";
import { useAccountParam } from "@/features/trading/useAccountParam";
import { cn, formatDateTime, formatMoney, formatPrice } from "@/lib/utils";
import { ChecksList } from "@/pages/RiskPage";
import type { OrderStatus } from "@/services/api";

const STATUS_TONE: Record<OrderStatus, "positive" | "info" | "neutral" | "negative" | "warning"> = {
  FILLED: "positive", OPEN: "info", CANCELLED: "neutral", REJECTED: "negative", EXPIRED: "warning",
};
const FILTERS = ["", "OPEN", "FILLED", "REJECTED", "CANCELLED", "EXPIRED"];
const num = (v: string | null, d = 8) => (v == null ? "—" : Number(v).toLocaleString("en-GB", { maximumFractionDigits: d }));

export function HistoryPage() {
  const { accounts, list, account, select, params, setParams } = useAccountParam();
  const status = params.get("status") ?? "";
  const selected = params.get("order");
  const orders = useOrders(account?.id, status || undefined);
  const executions = useExecutions(account?.id);
  const cancel = useCancelOrder();
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n); };

  if (accounts.isLoading) return <Spinner className="mx-auto mt-16" />;
  if (!account) return <Card><EmptyState icon={<History />} title="No paper accounts" /></Card>;
  const ccy = account.base_currency;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-72">
          <Field label="Paper account" htmlFor="h-acct">
            <Select id="h-acct" value={account.id} onChange={(e) => select(e.target.value)}>
              {list.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.base_currency}</option>)}
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Status filter">
          {FILTERS.map((f) => (
            <button key={f || "all"} aria-pressed={status === f} onClick={() => set("status", f || null)}
              className={cn("rounded border px-2.5 py-1 text-xs", status === f ? "border-accent/60 bg-accent/10 text-accent" : "border-border text-muted hover:text-fg")}>
              {f ? f[0] + f.slice(1).toLowerCase() : "All"}
            </button>
          ))}
        </div>
      </div>
      <ErrorBanner error={orders.error ?? cancel.error} />

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader title="Orders" description={`${orders.data?.total ?? 0} orders · rejected orders are kept with their reason`} />
          {orders.isLoading ? <div className="p-8"><Spinner className="mx-auto" /></div> : (orders.data?.items.length ?? 0) === 0 ? (
            <EmptyState icon={<History />} title="No orders yet" />
          ) : (
            <Table>
              <thead><tr><Th>Time</Th><Th>Instrument</Th><Th>Side</Th><Th>Type</Th><Th className="text-right">Qty</Th><Th className="text-right">Price</Th><Th>Status</Th><Th /></tr></thead>
              <tbody>
                {orders.data!.items.map((o) => (
                  <Tr key={o.id} className={cn("cursor-pointer", selected === o.id && "bg-surface-3")} onClick={() => set("order", o.id)}>
                    <Td className="num whitespace-nowrap text-xs text-muted">{formatDateTime(o.created_at)}</Td>
                    <Td className="font-medium">{o.symbol}{o.source !== "manual" && <Badge tone="info" className="ml-1.5">{o.source}</Badge>}</Td>
                    <Td className={o.side === "BUY" ? "text-positive" : "text-negative"}>{o.side}</Td>
                    <Td className="text-xs">{o.type}{o.limit_price && ` ${num(o.limit_price)}`}{o.stop_price && ` ${num(o.stop_price)}`}</Td>
                    <Td className="num text-right">{num(o.quantity)}</Td>
                    <Td className="num text-right">{num(o.avg_fill_price, 6)}</Td>
                    <Td><Badge tone={STATUS_TONE[o.status]} title={o.reject_reason ?? undefined}>{o.status}</Badge></Td>
                    <Td className="text-right">{o.status === "OPEN" && (
                      <Button size="sm" variant="ghost" aria-label={`Cancel order ${o.symbol}`} disabled={cancel.isPending}
                        onClick={(e) => { e.stopPropagation(); cancel.mutate(o.id); }}><X />Cancel</Button>)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <OrderTimeline id={selected} onClose={() => set("order", null)} onSelect={(oid) => set("order", oid)} />
      </div>

      <Card>
        <CardHeader title="Executions" description="Every fill, with its costs and the ledger transaction it posted" />
        {(executions.data?.items.length ?? 0) === 0 ? <EmptyState title="No executions yet" /> : (
          <Table>
            <thead><tr><Th>Time</Th><Th>Instrument</Th><Th>Side</Th><Th className="text-right">Qty</Th><Th className="text-right">Price</Th><Th className="text-right">Fee</Th>
              <Th className="text-right">Spread + slippage</Th><Th className="text-right">Realised P&L</Th></tr></thead>
            <tbody>
              {executions.data!.items.map((x) => (
                <Tr key={x.id}>
                  <Td className="num whitespace-nowrap text-xs text-muted">{formatDateTime(x.executed_at)}</Td>
                  <Td className="font-medium">{x.symbol}</Td>
                  <Td className={x.side === "BUY" ? "text-positive" : "text-negative"}>{x.side}</Td>
                  <Td className="num text-right">{num(x.quantity)}</Td>
                  <Td className="num text-right">{num(x.price, 6)}</Td>
                  <Td className="num text-right">{formatMoney(x.fee, ccy)}</Td>
                  <Td className="num text-right">{formatMoney(Number(x.spread_cost) + Number(x.slippage_cost), ccy)}</Td>
                  <Td className={cn("num text-right", Number(x.realised_pnl) > 0 && "text-positive", Number(x.realised_pnl) < 0 && "text-negative")}>
                    {x.realised_pnl == null ? "—" : formatMoney(x.realised_pnl, ccy)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function OrderTimeline({ id, onClose, onSelect }: { id: string | null; onClose: () => void; onSelect: (id: string) => void }) {
  const order = useOrder(id);
  if (!id) return <Card><EmptyState title="Select an order">Its lifecycle events and fills appear here.</EmptyState></Card>;
  const o = order.data;
  return (
    <Card data-testid="order-timeline">
      <CardHeader title={o ? `${o.side} ${num(o.quantity)} ${o.symbol}` : "Order"} description={o ? `${o.type} · ${o.time_in_force} · source ${o.source}` : undefined}
        action={<button onClick={onClose} aria-label="Close order detail" className="text-muted hover:text-fg"><X className="size-4" /></button>} />
      <CardBody>
        {!o ? <Spinner className="mx-auto" /> : (
          <>
            {o.reject_reason && <p className="mb-3 rounded-md border border-negative/40 bg-negative/10 px-3 py-2 text-xs text-negative">{o.reject_reason}</p>}
            <ol className="relative space-y-4 border-l border-border pl-4">
              {o.events.map((e, i) => (
                <li key={i}>
                  <span className="absolute -left-[5px] mt-1 size-2.5 rounded-full border border-border-strong bg-surface-3" />
                  <div className="flex items-center justify-between text-sm"><span className="font-medium">{e.type}</span>
                    <span className="num text-[11px] text-subtle">{formatDateTime(e.created_at)}</span></div>
                  <dl className="mt-1 grid grid-cols-2 gap-x-3 text-[11px] text-muted">
                    {Object.entries(e.detail).filter(([, v]) => v != null && v !== "").map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-2"><dt className="text-subtle">{k}</dt><dd className="num truncate">{String(v)}</dd></div>
                    ))}
                  </dl>
                </li>
              ))}
            </ol>
            {o.risk_checks.length > 0 && <div className="mt-4"><p className="mb-1.5 text-[11px] uppercase tracking-wider text-subtle">Risk gate</p><ChecksList checks={o.risk_checks} compact /></div>}
            {o.children.length > 0 && (
              <div className="mt-4 text-xs"><p className="mb-1.5 text-[11px] uppercase tracking-wider text-subtle">Protective orders{o.children.some((c) => c.oco_group) && " (one cancels the other)"}</p>
                <ul className="space-y-1">{o.children.map((c) => (
                  <li key={c.id}><button className="flex w-full justify-between rounded border border-border px-2 py-1 hover:bg-surface-2" onClick={() => onSelect(c.id)}>
                    <span>{c.type} {num(c.stop_price ?? c.limit_price)}</span><Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge></button></li>))}</ul>
              </div>
            )}
            {o.parent_order_id && <button className="mt-3 text-xs text-accent hover:underline" onClick={() => onSelect(o.parent_order_id!)}>View entry order</button>}
            {o.executions.map((x) => (
              <dl key={x.id} className="mt-4 grid grid-cols-2 gap-2 rounded-md border border-border bg-surface-2 p-3 text-xs">
                <div><dt className="text-subtle">Fill price</dt><dd className="num">{formatPrice(x.price, 6)}</dd></div>
                <div><dt className="text-subtle">Reference (bid/ask)</dt><dd className="num">{formatPrice(x.reference_price, 6)}</dd></div>
                <div><dt className="text-subtle">FX rate</dt><dd className="num">{num(x.fx_rate, 6)}</dd></div>
                <div><dt className="text-subtle">Fee</dt><dd className="num">{num(x.fee, 4)}</dd></div>
                <div className="col-span-2"><dt className="text-subtle">Ledger transaction</dt><dd className="num truncate">{x.ledger_transaction_id}</dd></div>
              </dl>
            ))}
          </>
        )}
      </CardBody>
    </Card>
  );
}
