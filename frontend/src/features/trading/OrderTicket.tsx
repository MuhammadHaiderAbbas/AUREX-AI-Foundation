import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { useAccounts } from "@/features/accounts/hooks";
import { usePlaceOrder } from "@/features/trading/hooks";
import { cn, formatMoney, formatPrice } from "@/lib/utils";
import { ChecksList } from "@/pages/RiskPage";
import { api, type InstrumentWithQuote, type OrderDetail, type OrderSide, type OrderType } from "@/services/api";

const slug = (s: string) => s.replace("/", "");

/** Paper order ticket. Every order is simulated against live quotes — no real money moves. */
export function OrderTicket({ open, onClose, symbol, side: initialSide = "BUY", quantity: initialQty = "", accountId }: {
  open: boolean; onClose: () => void; symbol: string; side?: OrderSide; quantity?: string; accountId?: string;
}) {
  const accounts = useAccounts();
  const place = usePlaceOrder();
  const inst = useQuery({
    queryKey: ["instrument", symbol], enabled: open && !!symbol, refetchInterval: open ? 2000 : false,
    queryFn: () => api<InstrumentWithQuote>(`/markets/instruments/${encodeURIComponent(slug(symbol))}`),
  });
  const [account, setAccount] = useState(accountId ?? "");
  const [side, setSide] = useState<OrderSide>(initialSide);
  const [type, setType] = useState<OrderType>("MARKET");
  const [qty, setQty] = useState(initialQty);
  const [price, setPrice] = useState("");
  const [tif, setTif] = useState<"GTC" | "DAY">("GTC");
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [result, setResult] = useState<OrderDetail | null>(null);

  useEffect(() => {
    if (!open) return;
    setSide(initialSide); setQty(initialQty); setType("MARKET"); setPrice(""); setSl(""); setTp(""); setResult(null);
    setKey(crypto.randomUUID()); place.reset();
    if (accountId) setAccount(accountId);
  }, [open, symbol, initialSide, initialQty, accountId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!account && accounts.data?.[0]) setAccount(accounts.data[0].id);
  }, [account, accounts.data]);

  const i = inst.data?.instrument;
  const q = inst.data?.quote;
  const acct = accounts.data?.find((a) => a.id === account);
  const ref = q ? Number(side === "BUY" ? q.ask : q.bid) : null;
  const px = type === "MARKET" ? ref : Number(price) || null;
  const notional = px && Number(qty) ? px * Number(qty) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const o = await place.mutateAsync({
      account_id: account, symbol, side, type, quantity: qty, time_in_force: tif, client_order_id: key,
      ...(type === "LIMIT" ? { limit_price: price } : type === "STOP" ? { stop_price: price } : {}),
      ...(side === "BUY" && sl ? { stop_loss: sl } : {}), ...(side === "BUY" && tp ? { take_profit: tp } : {}),
    });
    setResult(o);
    setKey(crypto.randomUUID());
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Paper order · ${symbol}`}>
      {result ? <OrderResult o={result} decimals={i?.price_decimals ?? 2} onClose={onClose} onAgain={() => { setResult(null); place.reset(); }} /> : (
        <form onSubmit={submit} className="space-y-4" aria-label="Order ticket">
          <div className="grid grid-cols-2 gap-1 rounded-md bg-surface-2 p-1" role="group" aria-label="Side">
            {(["BUY", "SELL"] as const).map((s) => (
              <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)}
                className={cn("rounded px-3 py-1.5 text-xs font-semibold", side === s ? (s === "BUY" ? "bg-positive/20 text-positive" : "bg-negative/20 text-negative") : "text-muted hover:text-fg")}>
                {s === "BUY" ? "Buy" : "Sell"}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between rounded-md border border-border bg-surface-2 px-3 py-2 text-xs">
            {q && i ? (<>
              <span>Bid <span className="num text-fg">{formatPrice(q.bid, i.price_decimals)}</span></span>
              <span>Ask <span className="num text-fg">{formatPrice(q.ask, i.price_decimals)}</span></span>
              {q.tradable ? <Badge tone="positive">Tradable</Badge> : <Badge tone="warning">{q.market_open ? "Stale" : "Market closed"}</Badge>}
            </>) : <Spinner />}
          </div>
          <ErrorBanner error={place.error ?? accounts.error} />
          <Field label="Paper account" htmlFor="ot-acct">
            <Select id="ot-acct" value={account} onChange={(e) => setAccount(e.target.value)} required>
              {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.name} · {formatMoney(a.cash_balance, a.base_currency)}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Order type" htmlFor="ot-type">
              <Select id="ot-type" value={type} onChange={(e) => setType(e.target.value as OrderType)}>
                <option value="MARKET">Market</option><option value="LIMIT">Limit</option><option value="STOP">Stop</option>
              </Select>
            </Field>
            <Field label="Quantity" htmlFor="ot-qty" hint={i ? `Lot size ${Number(i.lot_size).toLocaleString("en-GB", { maximumFractionDigits: 10 })}` : undefined}>
              <Input id="ot-qty" inputMode="decimal" required pattern="^\d+(\.\d{1,10})?$" className="num" value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
          </div>
          {type !== "MARKET" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label={type === "LIMIT" ? "Limit price" : "Stop price"} htmlFor="ot-price" hint={i ? `${i.price_decimals} decimals, ${i.quote_currency}` : undefined}>
                <Input id="ot-price" inputMode="decimal" required pattern="^\d+(\.\d{1,10})?$" className="num" value={price} onChange={(e) => setPrice(e.target.value)} />
              </Field>
              <Field label="Time in force" htmlFor="ot-tif">
                <Select id="ot-tif" value={tif} onChange={(e) => setTif(e.target.value as "GTC" | "DAY")}>
                  <option value="GTC">Good till cancelled (30d)</option><option value="DAY">Day (until 00:00 UTC)</option>
                </Select>
              </Field>
            </div>
          )}
          {side === "BUY" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Stop loss (optional)" htmlFor="ot-sl" hint="Protective stop placed on fill">
                <Input id="ot-sl" inputMode="decimal" pattern="^\d+(\.\d{1,10})?$" className="num" value={sl} onChange={(e) => setSl(e.target.value)} />
              </Field>
              <Field label="Take profit (optional)" htmlFor="ot-tp" hint="One cancels the other">
                <Input id="ot-tp" inputMode="decimal" pattern="^\d+(\.\d{1,10})?$" className="num" value={tp} onChange={(e) => setTp(e.target.value)} />
              </Field>
            </div>
          )}
          <p className="text-xs text-muted">
            Estimated {side === "BUY" ? "cost" : "proceeds"}: <span className="num text-fg">{notional && i ? `${formatPrice(notional, 2)} ${i.quote_currency}` : "—"}</span>
            {acct && i && acct.base_currency !== i.quote_currency && <> · converted to {acct.base_currency} at the live FX rate</>}.
            Fills include spread, slippage and fees. Spot only: no shorting, no leverage. Every order passes the risk gate
            {side === "BUY" && !sl && <> (without a stop loss, risk is estimated with a default stop distance)</>}.
          </p>
          <Button type="submit" className="w-full" variant={side === "BUY" ? "primary" : "danger"} disabled={place.isPending || !account || !qty}>
            {place.isPending && <Spinner />}Place paper {side === "BUY" ? "buy" : "sell"} order
          </Button>
        </form>
      )}
    </Dialog>
  );
}

function OrderResult({ o, decimals, onClose, onAgain }: { o: OrderDetail; decimals: number; onClose: () => void; onAgain: () => void }) {
  const ok = o.status === "FILLED" || o.status === "OPEN";
  const exe = o.executions[0];
  return (
    <div className="space-y-4" data-testid="order-result">
      <p className={cn("flex items-center gap-2 text-sm font-medium", ok ? "text-positive" : "text-negative")}>
        {ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
        {o.status === "FILLED" ? `Filled ${Number(o.quantity)} ${o.symbol} @ ${formatPrice(o.avg_fill_price, decimals)}`
          : o.status === "OPEN" ? `${o.type} order working — it fills when the price is reached`
          : `Order rejected: ${o.reject_reason}`}
      </p>
      {o.status === "REJECTED" && o.risk_checks.length > 0 && <ChecksList checks={o.risk_checks} compact />}
      {o.children.length > 0 && <p className="text-xs text-muted">Protective orders placed: {o.children.map((c) => `${c.type} ${Number(c.stop_price ?? c.limit_price)}`).join(" · ")}</p>}
      {exe && (
        <dl className="grid grid-cols-3 gap-2 text-xs">
          <div><dt className="text-subtle">Fee</dt><dd className="num">{formatPrice(exe.fee, 2)}</dd></div>
          <div><dt className="text-subtle">Spread cost</dt><dd className="num">{formatPrice(exe.spread_cost, 2)}</dd></div>
          <div><dt className="text-subtle">Slippage</dt><dd className="num">{formatPrice(exe.slippage_cost, 2)}</dd></div>
        </dl>
      )}
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={onAgain}>New order</Button>
        <Link to={`/history?order=${o.id}`} className="flex-1" onClick={onClose}><Button variant="outline" className="w-full">View in history</Button></Link>
      </div>
    </div>
  );
}
