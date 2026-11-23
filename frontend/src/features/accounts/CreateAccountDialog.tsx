import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { useCreateAccount, useSystemInfo } from "./hooks";

export function CreateAccountDialog({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated?: (id: string) => void;
}) {
  const info = useSystemInfo();
  const create = useCreateAccount();
  const [name, setName] = useState("Main paper account");
  const [currency, setCurrency] = useState("USD");
  const [balance, setBalance] = useState("100000");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const acct = await create.mutateAsync({ name, base_currency: currency, starting_balance: balance });
    onCreated?.(acct.id);
    onClose();
  }

  return (
    <Dialog open={open} onClose={() => { create.reset(); onClose(); }} title="New paper account">
      <form onSubmit={submit} className="space-y-4">
        <ErrorBanner error={create.error} />
        <Field label="Account name" htmlFor="acct-name">
          <Input id="acct-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-[110px_1fr] gap-3">
          <Field label="Currency" htmlFor="acct-ccy">
            <Select id="acct-ccy" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {(info.data?.supported_currencies ?? ["USD", "GBP", "EUR"]).map((c) => <option key={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Virtual starting balance" htmlFor="acct-bal" hint="Maximum 10,000,000. Virtual funds only.">
            <Input id="acct-bal" inputMode="decimal" required pattern="^\d+(\.\d{1,8})?$" className="num" value={balance} onChange={(e) => setBalance(e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={create.isPending}>{create.isPending && <Spinner className="text-accent-fg" />}Create account</Button>
        </div>
      </form>
    </Dialog>
  );
}
