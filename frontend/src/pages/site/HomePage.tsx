import {
  ArrowRight, BarChart3, Bot, BrainCircuit, CheckCircle2, FlaskConical, KeyRound, Landmark, LineChart, Lock, ScrollText,
  ShieldCheck, Sparkles, Wallet, Workflow,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Faq, FeatureCard, HeroMarkets, Section, TickerTape } from "@/components/site/widgets";
import { MarketsTable } from "@/pages/site/MarketsPublicPage";
import { isDemo } from "@/services/api";

const AGENTS: [string, string, number][] = [
  ["Technical", "Trend, momentum and volatility from the chart", 0.42],
  ["Quant", "Statistical drift with a forecast interval", 0.18],
  ["Market regime", "Calm, trending or turbulent: should we trade at all?", 0],
  ["News & sentiment", "Recent documents, scored and dated", 0.12],
  ["Fundamentals", "Valuation and macro context", -0.08],
  ["ML model", "Only a model that passed every validation gate", 0.21],
  ["Portfolio", "Sizing against your balance and limits", 0],
  ["Risk gate", "Independent veto on every order", 0],
];

export function HomePage() {
  return (
    <>
      {/* Hero */}
      <div className="bg-grid relative overflow-hidden">
        <div className="pointer-events-none absolute -top-40 left-1/2 size-[640px] -translate-x-1/2 rounded-full bg-accent/15 blur-3xl" />
        <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 py-16 lg:grid-cols-[1.1fr_1fr] lg:px-6 lg:py-24">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface/80 px-3 py-1 text-xs text-muted">
              <Sparkles className="size-3.5 text-accent" /> AI trading desk · paper money, real prices
            </span>
            <h1 className="mt-5 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl lg:text-6xl">
              Trade with an AI desk that <span className="text-accent">shows its work.</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg text-muted">
              Eight AI specialists analyse every market, vote and explain why. An independent risk engine checks every order.
              Start with £100 of virtual money on live crypto and forex prices, with no risk to your own.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/register"><Button size="lg">Create free account <ArrowRight /></Button></Link>
              <Link to={isDemo ? "/login" : "/ai-trading"}><Button size="lg" variant="secondary">{isDemo ? "Try the live demo" : "How the AI works"}</Button></Link>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
              {["No real money at risk", "Live Coinbase prices", "Two-factor sign-in"].map((t) => (
                <li key={t} className="flex items-center gap-2"><CheckCircle2 className="size-4 text-positive" />{t}</li>
              ))}
            </ul>
          </div>
          <HeroMarkets />
        </div>
      </div>
      <TickerTape />

      {/* Numbers */}
      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-6 px-4 py-12 md:grid-cols-4 lg:px-6">
        {[["15+", "live markets: crypto and forex"], ["8", "AI specialists on every decision"], ["9", "checks before a model can trade"], ["£100", "virtual starting balance"]].map(([n, l]) => (
          <div key={l}><div className="num text-3xl font-semibold">{n}</div><div className="mt-1 text-sm text-muted">{l}</div></div>
        ))}
      </div>

      {/* Markets */}
      <Section eyebrow="Markets" title="Live prices, the moment you arrive" intro="Track the biggest crypto assets and currency pairs. Sign in to chart them, trade them on paper and let the AI analyse them.">
        <MarketsTable limit={8} />
        <div className="mt-6 text-center"><Link to="/markets"><Button variant="secondary">See all markets <ArrowRight /></Button></Link></div>
      </Section>

      {/* AI spotlight */}
      <div className="border-y border-border bg-surface/40">
        <Section eyebrow="AI trading" title="Eight specialists. One accountable decision."
          intro="Each agent reads the market from its own angle and casts a scored vote with evidence. The orchestrator only proposes a trade when the evidence is strong and consistent. Otherwise the answer is “no trade”.">
          <div className="grid items-start gap-10 lg:grid-cols-[1fr_1.1fr]">
            <div className="rounded-2xl border border-border bg-surface p-5" aria-label="Illustration of an agent vote">
              <div className="flex items-center justify-between text-sm"><span className="font-semibold">BTC-USD · 4-hour view</span><span className="text-xs text-subtle">illustration</span></div>
              <ul className="mt-4 space-y-3">
                {AGENTS.map(([name, , v]) => (
                  <li key={name} className="grid grid-cols-[120px_1fr_48px] items-center gap-3 text-sm">
                    <span className="text-muted">{name}</span>
                    <div className="relative h-2 rounded-full bg-surface-3">
                      <div className={`absolute top-0 h-2 rounded-full ${v >= 0 ? "left-1/2 bg-positive" : "right-1/2 bg-negative"}`} style={{ width: `${Math.abs(v) * 100}%` }} />
                      <div className="absolute top-[-3px] left-1/2 h-3.5 w-px bg-border-strong" />
                    </div>
                    <span className={`num text-right text-xs ${v > 0 ? "text-positive" : v < 0 ? "text-negative" : "text-subtle"}`}>{v === 0 ? "gate" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-5 flex items-center justify-between rounded-xl bg-surface-2 px-4 py-3">
                <span className="text-sm text-muted">Decision</span>
                <span className="text-sm font-semibold text-positive">BUY · confidence 64% · risk gate passed</span>
              </div>
            </div>
            <ul className="grid gap-4 sm:grid-cols-2">
              {AGENTS.map(([name, desc]) => (
                <li key={name} className="rounded-xl border border-border/70 bg-surface p-4">
                  <div className="font-medium">{name}</div><p className="mt-1 text-sm text-muted">{desc}</p>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      </div>

      {/* Features */}
      <Section eyebrow="Platform" title="Everything a trading desk needs" intro="Professional tools, explained in plain words.">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard icon={<Bot />} title="AI desk & autopilot" to="/ai-trading">Run the agent desk on any market, or let autopilot trade your paper account on a schedule, always through the risk gate.</FeatureCard>
          <FeatureCard icon={<LineChart />} title="Pro charts">Candles from 1 minute to 1 day with SMA, EMA, Bollinger bands, RSI and MACD, updating live.</FeatureCard>
          <FeatureCard icon={<ShieldCheck />} title="Independent risk engine" to="/security">Loss limits, drawdown limits, position caps, circuit breakers and a kill switch that the AI cannot override.</FeatureCard>
          <FeatureCard icon={<Workflow />} title="Model Lab">Machine-learning models are tested on data they never saw, after costs, and must pass nine checks before they can vote.</FeatureCard>
          <FeatureCard icon={<FlaskConical />} title="Backtesting">Replay strategies on history with realistic spread, slippage and fees, then test them once on unseen data.</FeatureCard>
          <FeatureCard icon={<BrainCircuit />} title="Research Lab">Ask questions about your documents and get answers with citations, or an honest “not enough evidence”.</FeatureCard>
          <FeatureCard icon={<BarChart3 />} title="Analytics & reports">Returns, Sharpe, drawdown, benchmark comparison and AI accuracy, with a printable report.</FeatureCard>
          <FeatureCard icon={<Wallet />} title="Accounts from £100">GBP, USD and more. Fractional quantities mean a £100 account can trade properly.</FeatureCard>
          <FeatureCard icon={<ScrollText />} title="Full audit trail">Every order, AI decision and setting change is recorded in a tamper-evident log.</FeatureCard>
        </div>
      </Section>

      {/* How it works */}
      <div className="border-y border-border bg-surface/40">
        <Section eyebrow="How it works" title="Up and running in minutes">
          <ol className="grid gap-5 md:grid-cols-3">
            {[["Create your account", "Sign up, turn on two-factor sign-in and open a paper account with £100 of virtual money."],
              ["Ask the AI", "Pick a market. The desk analyses it, shows every agent's evidence and proposes a trade, or no trade."],
              ["Trade with guardrails", "Place orders yourself or switch on autopilot. The risk engine checks every one and logs why."]].map(([t, d], i) => (
              <li key={t} className="rounded-2xl border border-border/70 bg-surface p-6">
                <div className="num flex size-9 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-fg">{i + 1}</div>
                <h3 className="mt-4 font-semibold">{t}</h3><p className="mt-2 text-sm text-muted">{d}</p>
              </li>
            ))}
          </ol>
        </Section>
      </div>

      {/* Trust */}
      <Section eyebrow="Security" title="Built like a bank's back office" intro="Safety first, then features.">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <FeatureCard icon={<KeyRound />} title="Two-factor sign-in">Authenticator-app codes and one-time recovery codes. Administrators must use them.</FeatureCard>
          <FeatureCard icon={<Landmark />} title="Double-entry ledger">Every penny is recorded twice, so balances always reconcile.</FeatureCard>
          <FeatureCard icon={<Lock />} title="Paper trading only">Real-money trading is disabled in the code and the database.</FeatureCard>
          <FeatureCard icon={<ScrollText />} title="Tamper-evident audit">Records are chained, so any edit to history is detectable.</FeatureCard>
        </div>
      </Section>

      {/* FAQ */}
      <div className="border-t border-border bg-surface/40">
        <Section eyebrow="FAQ" title="Questions, answered">
          <Faq items={[
            ["Is this real money?", "No. AUREX is a paper-trading platform: balances are virtual, prices are real. It is for learning, research and testing strategies without risk."],
            ["Will the AI make me money?", "There is no guarantee, and no honest platform can promise one. The AI is built to refuse trades when its evidence is weak, and every result is measured on data it never saw."],
            ["Which markets can I trade?", "Twelve major crypto assets with live Coinbase prices and the main forex pairs with live rates. US stocks and ETFs are live on a self-hosted server with a free data key, and simulated (labelled) elsewhere."],
            ["Do I need to install anything?", "No. AUREX runs in your browser on desktop and mobile."],
            ["How is my account protected?", "Strong password hashing, optional two-factor sign-in, short sessions, rate limits and a full audit trail. See the Security page."],
          ]} />
        </Section>
      </div>

      {/* CTA */}
      <div className="mx-auto max-w-7xl px-4 py-16 lg:px-6">
        <div className="relative overflow-hidden rounded-3xl border border-accent/30 bg-accent/10 px-6 py-12 text-center">
          <h2 className="text-3xl font-semibold tracking-tight">Start trading smarter, risk free</h2>
          <p className="mx-auto mt-3 max-w-xl text-muted">Open a £100 paper account in under a minute and see what the AI desk thinks of today's markets.</p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link to="/register"><Button size="lg">Create free account <ArrowRight /></Button></Link>
            <Link to="/login"><Button size="lg" variant="secondary">Log in</Button></Link>
          </div>
        </div>
      </div>
    </>
  );
}
