/** Browser port of backend/app/coach.py `builtin`: plain-English answers from the trader's own data. Keep in sync. */
import { wilson } from "./binarybot";

export interface CoachCtx {
  account: { name: string; currency: string; equity: number; cash: number; unrealised_pnl: number; realised_pnl: number; fees: number; open_positions: number } | null;
  binary: { payout_rate: number; break_even: number; won: number; lost: number; net_pnl: number; win_rate: number | null; win_rate_95: [number, number];
    bot_status: string; bot_paused_reason: string | null; bot_expiry_seconds: number } | null;
  last_ai_run: { symbol: string; decision: string; net_score: number; agreement: number; reasons: string[];
    agents: { agent: string; status: string; direction: number; score: number; summary: string }[] } | null;
  closed_trades: { symbol: string; realised_pnl: number; fees: number }[];
}
export interface CoachAnswer { answer: string; facts: string[]; engine: string; suggestions: string[] }

const GLOSSARY: Record<string, string> = {
  "break-even": "Break-even win rate is how often you must be right just to not lose money. A binary contract pays 80% of the stake if right and loses the whole stake if wrong, so you need to win 1 / 1.8 = 55.6% of the time. Below that, you lose on average.",
  drawdown: "Drawdown is how far your account is below its highest value so far, in percent. A 10% drawdown means you are 10% below your best. The risk engine stops trading if it gets too deep.",
  stop: "A stop-loss is an order that sells automatically if the price falls to a level you choose, to cap how much one trade can lose.",
  leverage: "Leverage lets you control a bigger position than your cash. With 5x, £10 of margin controls £50 of crypto, so a 1% move changes your margin by 5%, in either direction.",
  liquidation: "Liquidation is when a leveraged position has lost almost all its margin, so it is closed automatically. The liquidation price is shown before you trade, and it is closer to your entry the higher the leverage.",
  funding: "Funding is a small fee paid between long and short traders on perpetual futures every 8 hours, to keep the futures price close to the real price.",
  spread: "The spread is the gap between the buy (ask) and sell (bid) price. You pay it every time you trade.",
  slippage: "Slippage is the difference between the price you expected and the price you got, usually because the order was bigger than the best price had room for.",
  rsi: "RSI (relative strength index) is a 0-100 gauge of recent momentum. Above 70 is often called overbought, below 30 oversold. It is a hint, not a signal on its own.",
  sma: "A simple moving average (SMA) is the average price over the last N candles. Price above a rising SMA suggests an up-trend.",
  paper: "Paper trading means trading with virtual money on real prices. Nothing you do on AUREX can lose real money.",
};
export const SUGGESTIONS = ["Why is my bot losing?", "Why did the AI say no trade?", "How am I doing?", "What is break-even win rate?", "Explain my last trade", "What is leverage?"];
const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
const money = (v: number, ccy: string) => { const sym = ({ GBP: "£", USD: "$", EUR: "€" } as Record<string, string>)[ccy] ?? ""; return `${v < 0 ? "-" : ""}${sym}${Math.abs(v).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${sym ? "" : ` ${ccy}`}`; };
const has = (q: string, ws: string[]) => ws.some((w) => q.includes(w));

export function builtin(question: string, ctx: CoachCtx): CoachAnswer {
  const q = question.toLowerCase(), { account: acct, binary: b, last_ai_run: r } = ctx, ccy = acct?.currency ?? "GBP";
  const ans = (answer: string, facts: string[] = []): CoachAnswer => ({ answer, facts, engine: "builtin", suggestions: SUGGESTIONS });
  for (const [k, text] of Object.entries(GLOSSARY)) {
    if ((q.includes(k) || (k === "break-even" && q.includes("breakeven")) || (k === "stop" && q.includes("stop-loss"))) && !has(q, ["my ", "bot", "why"])) return ans(text, ["Definition"]);
  }
  if (has(q, ["bot", "binary", "losing", "lose", "lost", "win rate"]) && b) {
    const n = b.won + b.lost, [lo, hi] = b.win_rate_95, parts: string[] = [];
    if (n) {
      parts.push(`Your recent binary record is ${b.won} won and ${b.lost} lost (${pct(b.win_rate ?? 0)}), net ${money(b.net_pnl, ccy)}. To break even you need to win ${pct(b.break_even, 1)} of the time, because a win pays ${pct(b.payout_rate)} of the stake but a loss costs all of it.`);
      if (n < 30) parts.push(`${n} contracts is far too few to judge. With that record the true win rate could be anywhere from ${pct(lo)} to ${pct(hi)} (95% range), so this could be bad luck or a real lack of edge. It takes dozens of contracts to tell.`);
      else if (hi < b.break_even) parts.push("Over this many contracts the record is clearly below break-even: the bot has no edge here.");
    }
    parts.push(`Short expiries (${b.bot_expiry_seconds} seconds for your bot) are mostly random noise, so even a good model wins only slightly more than half the time. The bot only trades when its out-of-sample tests show a proven edge, and it pauses itself when its live record shows it has none.`);
    if (b.bot_status === "PAUSED" && b.bot_paused_reason) parts.push(`Right now it is paused: ${b.bot_paused_reason}.`);
    return ans(parts.join("\n\n"), [`${n} settled binary contracts`, `break-even ${pct(b.break_even, 1)}`, `bot ${b.bot_status.toLowerCase()}`]);
  }
  if (has(q, ["no trade", "ai", "agent", "desk", "decision", "why did"]) && r) {
    const parts = [`The last AI desk run on ${r.symbol} decided ${r.decision === "BUY" ? "BUY" : "NO TRADE"} (net score ${r.net_score >= 0 ? "+" : ""}${r.net_score.toFixed(2)}, agents agreeing ${pct(r.agreement)}).`];
    if (r.reasons.length) parts.push(`The main reasons were: ${r.reasons.slice(0, 3).join("; ")}.`);
    const strong = r.agents.filter((a) => a.status === "ok").slice(0, 3);
    if (strong.length) parts.push(`The agents with the strongest views: ${strong.map((a) => `${a.agent} (${a.direction > 0 ? "up" : a.direction < 0 ? "down" : "neutral"}, ${a.score >= 0 ? "+" : ""}${a.score.toFixed(2)}): ${a.summary.slice(0, 140)}`).join("; ")}.`);
    parts.push("The desk only proposes a trade when the evidence is strong and consistent and every safety check passes. 'No trade' is often the honest answer in a quiet or mixed market.");
    return ans(parts.join("\n\n"), [`AI run on ${r.symbol}`, `decision ${r.decision}`]);
  }
  if (has(q, ["last trade", "my trade", "closed"]) && ctx.closed_trades.length) {
    const t = ctx.closed_trades[0]!;
    return ans(`Your last closed trade was ${t.symbol}: you ${t.realised_pnl > 0 ? "made" : "lost"} ${money(Math.abs(t.realised_pnl), ccy)} after ${money(t.fees, ccy)} of fees. Small trades are hit hardest by fees and spread, so very short trades need a bigger move to come out ahead.`, [`last closed position ${t.symbol}`]);
  }
  if (acct && has(q, ["how am i", "doing", "performance", "profit", "equity", "balance", "account"])) {
    const pnl = acct.unrealised_pnl + acct.realised_pnl;
    return ans(`${acct.name} is worth ${money(acct.equity, ccy)}, with ${money(acct.cash, ccy)} in cash and ${acct.open_positions} open position(s). Total profit and loss so far is ${money(pnl, ccy)} (fees paid ${money(acct.fees, ccy)}). For a fuller picture, Analytics shows your return, drawdown and how you compare with simply holding the market.`, [`account ${acct.name}`]);
  }
  if (!acct) return ans("You don't have a paper account yet. Create one from the Dashboard (start with £100), then I can explain your trades and results.");
  return ans("I can explain your bot's results, why the AI desk did or didn't trade, your last trade, how your account is doing, and trading terms such as break-even, drawdown, spread, leverage or liquidation. Try one of the suggestions below.");
}

export const winRate95 = (won: number, n: number) => wilson(won, n);
