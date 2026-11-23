import { ArrowDownLeft, ArrowUpRight, BookOpen, CheckCircle2, Plus, Wallet, XCircle } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { Stat } from "@/components/ui/stat";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { CreateAccountDialog } from "@/features/accounts/CreateAccountDialog";
import { useAccounts, useBalances, useCashMovement, useLedger } from "@/features/accounts/hooks";
import { cn, formatDateTime, formatMoney } from "@/lib/utils";
import type { TradingAccount } from "@/services/api";

const TXN_LABEL: Record<string, string> = {
  INITIAL_FUNDING: "Initial funding",
  VIRTUAL_DEPOSIT: "Virtual deposit",
  VIRTUAL_WITHDRAWAL: "Virtual withdrawal",
  TRADE_BUY: "Trade · buy",
  TRADE_SELL: "Trade · sell",
};

function CashMovementForm({ account }: { account: TradingAccount }) {
  const [kind, setKind] = useState<"deposits" | "withdrawals">("deposits");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  // One idempotency key per intended movement: retries after a network error reuse it.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [done, setDone] = useState<string | null>(null);
  const move = useCashMovement(account.id);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setDone(null);
    await move.mutateAsync({ kind, amount, description, key });
    setDone(`${kind === "deposits" ? "Deposited" : "Withdrew"} ${formatMoney(amount, account.base_currency)}`);
    setAmount(""); setDescription(""); setKey(crypto.randomUUID());
  }

  return (
    <Card>
      <CardHeader title="Move virtual cash" description="Simulated funds only — never real money" />
      <CardBody>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-1 rounded-md bg-surface-2 p-1" role="tablist">
            {(["deposits", "withdrawals"] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={kind === k}
                onClick={() => { setKind(k); move.reset(); setDone(null); setKey(crypto.randomUUID()); }}
                className={cn("flex items-center justify-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium",
                  kind === k ? "bg-surface-3 text-fg" : "text-muted hover:text-fg")}>
                {k === "deposits" ? <ArrowDownLeft className="size-3.5" /> : <ArrowUpRight className="size-3.5" />}
                {k === "deposits" ? "Deposit" : "Withdraw"}
              </button>
            ))}
          </div>
          <ErrorBanner error={move.error} />
          {done && <p className="flex items-center gap-2 text-sm text-positive"><CheckCircle2 className="size-4" />{done}</p>}
          <Field label={`Amount (${account.base_currency})`} htmlFor="amount">
            <Input id="amount" inputMode="decimal" required pattern="^\d+(\.\d{1,8})?$" placeholder="0.00"
              className="num" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Note (optional)" htmlFor="desc">
            <Input id="desc" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Button type="submit" className="w-full" disabled={move.isPending || account.status !== "ACTIVE"}>
            {move.isPending && <Spinner className="text-accent-fg" />}
            {kind === "deposits" ? "Deposit virtual cash" : "Withdraw virtual cash"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export function WalletPage() {
  const accounts = useAccounts();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const list = accounts.data ?? [];
  const selectedId = params.get("account") ?? list[0]?.id;
  const account = list.find((a) => a.id === selectedId) ?? list[0];
  const balances = useBalances(account?.id);
  const ledger = useLedger(account?.id);

  useEffect(() => {
    if (account && params.get("account") !== account.id) setParams({ account: account.id }, { replace: true });
  }, [account, params, setParams]);

  if (accounts.isLoading) return <Spinner className="mx-auto mt-16" />;
  if (list.length === 0) {
    return (
      <Card>
        <EmptyState icon={<Wallet />} title="No paper accounts">
          Create a paper account to start with virtual capital.
          <div className="mt-4"><Button size="sm" onClick={() => setCreating(true)}><Plus />Create paper account</Button></div>
        </EmptyState>
        <CreateAccountDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => setParams({ account: id })} />
      </Card>
    );
  }
  const ccy = account!.base_currency;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-72">
          <Field label="Paper account" htmlFor="acct">
            <Select id="acct" value={account!.id} onChange={(e) => setParams({ account: e.target.value })}>
              {list.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.base_currency}</option>)}
            </Select>
          </Field>
        </div>
        <Button variant="secondary" onClick={() => setCreating(true)}><Plus />New account</Button>
        {balances.data && (
          <span className={cn("ml-auto flex items-center gap-1.5 text-xs", balances.data.ledger_balanced ? "text-positive" : "text-negative")}>
            {balances.data.ledger_balanced ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
            {balances.data.ledger_balanced ? "Ledger balanced (debits = credits)" : "Ledger imbalance detected"}
          </span>
        )}
      </div>

      <ErrorBanner error={balances.error ?? ledger.error} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Equity" value={balances.data ? formatMoney(balances.data.equity, ccy) : "—"} sub="Assets − liabilities" />
        <Stat label="Cash" value={balances.data ? formatMoney(balances.data.cash, ccy) : "—"} sub="Available for simulated trading" />
        <Stat label="Investments at cost" value={balances.data ? formatMoney(balances.data.investments, ccy) : "—"} tone="muted" sub="Open positions at cost" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Ledger" description="Immutable double-entry journal. Newest first." />
            {ledger.isLoading ? <div className="p-8"><Spinner className="mx-auto" /></div> :
              (ledger.data?.items.length ?? 0) === 0 ? <EmptyState icon={<BookOpen />} title="No ledger entries" /> : (
                <Table>
                  <thead><tr><Th>Time</Th><Th>Type</Th><Th>Ledger account</Th><Th className="text-right">Debit</Th><Th className="text-right">Credit</Th></tr></thead>
                  <tbody>
                    {ledger.data!.items.map((t) => t.entries.map((e, i) => (
                      <Tr key={`${t.id}-${i}`} className={cn(i === t.entries.length - 1 && "[&>td]:border-border")}>
                        <Td className="num whitespace-nowrap text-xs text-muted">{i === 0 ? formatDateTime(t.created_at) : ""}</Td>
                        <Td>{i === 0 && (<><span className="text-sm">{TXN_LABEL[t.type] ?? t.type}</span>
                          {t.description && <div className="text-[11px] text-subtle">{t.description}</div>}</>)}</Td>
                        <Td className={cn("num text-xs", e.direction === "CREDIT" && "pl-8")}>{e.ledger_code}</Td>
                        <Td className="num text-right">{e.direction === "DEBIT" ? formatMoney(e.amount, e.currency) : ""}</Td>
                        <Td className="num text-right">{e.direction === "CREDIT" ? formatMoney(e.amount, e.currency) : ""}</Td>
                      </Tr>
                    )))}
                  </tbody>
                </Table>
              )}
          </Card>
        </div>

        <div className="space-y-6">
          <CashMovementForm account={account!} />
          <Card>
            <CardHeader title="Chart of accounts" description="Natural-sign balances" />
            <ul className="divide-y divide-border/60 text-sm">
              {balances.data?.lines.map((l) => (
                <li key={l.code} className="flex items-center justify-between px-5 py-2">
                  <span><span className="text-fg">{l.name}</span> <Badge className="ml-1">{l.type}</Badge></span>
                  <span className="num">{formatMoney(l.balance, l.currency)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
      <CreateAccountDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => setParams({ account: id })} />
    </div>
  );
}
