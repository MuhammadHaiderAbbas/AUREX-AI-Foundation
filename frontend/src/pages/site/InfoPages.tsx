import { ArrowRight, Bot, CheckCircle2, Gauge, KeyRound, Landmark, Lock, PauseCircle, ScrollText, ServerCog, ShieldCheck, Timer, Workflow, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { FeatureCard, PageHero, Section } from "@/components/site/widgets";

function Cta({ title, text }: { title: string; text: string }) {
  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 lg:px-6">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-accent/30 bg-accent/10 p-8">
        <div><h3 className="text-xl font-semibold">{title}</h3><p className="mt-1 text-muted">{text}</p></div>
        <Link to="/register"><Button size="lg">Create free account <ArrowRight /></Button></Link>
      </div>
    </div>
  );
}

export function AiTradingInfoPage() {
  return (
    <>
      <PageHero eyebrow="AI trading" title="An AI desk that explains itself, and knows when to stay out"
        intro="Most “AI trading” tools are a black box that always wants to trade. AUREX is the opposite: every decision comes with evidence, and doing nothing is a valid answer." />
      <Section title="Three ways to use the AI">
        <div className="grid gap-5 md:grid-cols-3">
          <FeatureCard icon={<Bot />} title="Agent desk">Pick any market and run the desk. Eight specialists vote with evidence, the orchestrator weighs them and proposes BUY, SELL or NO TRADE, with entry, stop and size.</FeatureCard>
          <FeatureCard icon={<Gauge />} title="Autopilot">Choose up to five markets. On a schedule, the desk analyses each one and executes approved proposals on your paper account, and every order still passes the risk gate.</FeatureCard>
          <FeatureCard icon={<Timer />} title="Binary bot (paper)">A one-button bot for 1-minute HIGHER/LOWER contracts on BTC and ETH. It only trades while its accuracy on unseen data beats break-even, and pauses itself when it stops winning.</FeatureCard>
        </div>
      </Section>
      <div className="border-y border-border bg-surface/40">
        <Section title="Honest by design" intro="Rules the AI cannot break.">
          <ul className="grid gap-4 md:grid-cols-2">
            {[
              ["Out-of-sample or it doesn't count", "Models and strategies are judged only on data they never trained on, after spread, slippage and fees."],
              ["Nine gates before a model can vote", "Beat buy-and-hold, beat momentum, calibrated probabilities, enough trades, consistent across periods, plausible results, and real (not simulated) data."],
              ["Independent risk veto", "Position caps, daily loss and drawdown limits, circuit breakers and a platform kill switch. The AI cannot override them."],
              ["No trade is an answer", "When the evidence is weak or conflicting, the desk says so. On real BTC data today, most models are correctly rejected."],
            ].map(([t, d]) => (
              <li key={t} className="flex gap-3 rounded-xl border border-border/70 bg-surface p-5"><CheckCircle2 className="mt-0.5 size-5 shrink-0 text-positive" /><div><div className="font-medium">{t}</div><p className="mt-1 text-sm text-muted">{d}</p></div></li>
            ))}
          </ul>
        </Section>
      </div>
      <Section title="What the AI will never do">
        <ul className="grid gap-3 md:grid-cols-3">
          {["Promise profits or guaranteed returns", "Trade real money: real-money trading is disabled", "Hide a losing streak: the edge guard pauses the bot"].map((t) => (
            <li key={t} className="flex items-center gap-3 rounded-xl border border-border/70 bg-surface p-4 text-sm"><XCircle className="size-5 shrink-0 text-negative" />{t}</li>
          ))}
        </ul>
      </Section>
      <Cta title="See the AI desk on today's markets" text="Open a free £100 paper account and run your first analysis." />
    </>
  );
}

export function SecurityPage() {
  return (
    <>
      <PageHero eyebrow="Security" title="Your account, protected at every layer" intro="Security and correctness come before features. Here is what protects you and the platform." />
      <Section title="Protecting your account">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard icon={<KeyRound />} title="Two-factor sign-in">Authenticator-app codes with one-time recovery codes. Required for administrators.</FeatureCard>
          <FeatureCard icon={<Lock />} title="Strong password storage">Passwords are hashed with Argon2 and never stored or logged in plain text.</FeatureCard>
          <FeatureCard icon={<ShieldCheck />} title="Short sessions">Short-lived access tokens, a refresh cookie scripts cannot read, and sign-out of all devices.</FeatureCard>
        </div>
      </Section>
      <Section title="Protecting the platform" className="pt-0">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard icon={<Landmark />} title="Double-entry ledger">Every movement of virtual money is recorded twice; balances always reconcile.</FeatureCard>
          <FeatureCard icon={<ScrollText />} title="Tamper-evident audit trail">Records are hash-chained and can be anchored externally, so history cannot be quietly rewritten.</FeatureCard>
          <FeatureCard icon={<PauseCircle />} title="Kill switch & maintenance">Administrators can halt all trading or put the platform on hold instantly.</FeatureCard>
          <FeatureCard icon={<ServerCog />} title="Hardened infrastructure">Read-only containers, least privilege, secrets in files, rate limits and strict security headers.</FeatureCard>
          <FeatureCard icon={<Workflow />} title="Checked on every change">Automated tests, dependency and container scanning, secret scanning and a backup-restore drill run on every update.</FeatureCard>
          <FeatureCard icon={<Lock />} title="Paper trading only">No broker is connected and real-money trading is disabled in code and in the database.</FeatureCard>
        </div>
      </Section>
      <Cta title="Trade with peace of mind" text="Create a free account and turn on two-factor sign-in in Settings." />
    </>
  );
}

export function AboutPage() {
  return (
    <>
      <PageHero eyebrow="About" title="Making AI trading transparent" intro="AUREX AI started from a simple idea: an AI that trades should be able to explain itself, prove itself on data it has never seen, and stop when it is wrong." />
      <Section title="What we believe">
        <div className="grid gap-5 md:grid-cols-3">
          {[["Evidence over hype", "Every AI decision shows its reasons. Every model is judged out of sample, after costs."],
            ["Safety over features", "A risk engine the AI cannot override, a kill switch, and paper money until everything is proven."],
            ["Learning for everyone", "Start with £100 of virtual money and professional tools, explained in plain words."]].map(([t, d]) => (
            <div key={t} className="rounded-2xl border border-border/70 bg-surface p-6"><h3 className="font-semibold">{t}</h3><p className="mt-2 text-sm text-muted">{d}</p></div>
          ))}
        </div>
      </Section>
      <Section title="Where we are" className="pt-0">
        <ol className="space-y-3">
          {[["Now", "Paper trading on live crypto and forex prices, the AI desk, autopilot, Model Lab, backtesting and analytics."],
            ["Next", "Price alerts and notifications, a guided tour for beginners and a mobile-first trading view."],
            ["Later", "Only after independent security testing and regulatory advice: any move beyond paper trading."]].map(([w, d]) => (
            <li key={w} className="flex gap-4 rounded-xl border border-border/70 bg-surface p-5"><span className="w-14 shrink-0 font-semibold text-accent">{w}</span><span className="text-sm text-muted">{d}</span></li>
          ))}
        </ol>
      </Section>
      <Cta title="Join the beta" text="It's free, it's paper money, and your feedback shapes what comes next." />
    </>
  );
}

const LEGAL: Record<string, { title: string; body: [string, ReactNode][] }> = {
  terms: { title: "Terms of use", body: [
    ["The service", "AUREX AI is a paper-trading, research and education platform. All balances are virtual. No real money, securities or crypto assets are bought, sold or held for you."],
    ["No advice", "Nothing on the platform, including AI output, is financial, investment, tax or legal advice. Decisions you make elsewhere are your own responsibility."],
    ["Your account", "Keep your password and two-factor device safe. You are responsible for activity on your account. We may suspend accounts that abuse the service."],
    ["Acceptable use", "Do not attempt to break, overload or reverse-engineer the service, access other people's data, or use it for anything unlawful."],
    ["Availability", "The service is provided as is. It may be paused for maintenance and features may change. Market data comes from third parties and may be delayed or wrong."],
    ["Changes", "We may update these terms; continued use after an update means you accept it."],
  ] },
  privacy: { title: "Privacy policy", body: [
    ["What we collect", "Your name, email, a hash of your password, sign-in times, your settings and your paper-trading activity. The public demo stores everything only in your own browser."],
    ["Why", "To run your account, keep it secure (for example detecting suspicious sign-ins) and keep an audit trail of trading activity."],
    ["Sharing", "We do not sell your data. Market-data providers receive no personal information from us."],
    ["Retention and your rights", "You can export your data or ask for your account to be deleted from Settings. Audit records may be kept as long as required to keep the trail verifiable."],
    ["Security", "Data is protected with encryption, hashing, access controls and monitoring. See the Security page."],
  ] },
  risk: { title: "Risk disclosure", body: [
    ["Paper trading is not real trading", "Simulated fills cannot fully reflect real liquidity, slippage, emotions or outages. Results here do not predict real results."],
    ["Markets are risky", "Crypto assets and forex are volatile. In real trading you can lose some or all of your money, quickly."],
    ["AI has limits", "Models can be wrong, stop working when markets change, or find patterns that are just noise. Past performance does not guarantee future results."],
    ["Binary options", "Binary options are banned for retail customers in the UK (FCA, since April 2019) and restricted across the EU/EEA. They appear here only as a paper simulation; with a payout below even money the average outcome is a loss."],
  ] },
};

export function LegalPage() {
  const { doc = "" } = useParams();
  const d = LEGAL[doc];
  if (!d) return <Navigate to="/legal/terms" replace />;
  return (
    <>
      <PageHero eyebrow="Legal" title={d.title} intro="Plain-English summary. Last updated November 2026. This text is a starting point and should be reviewed by a qualified lawyer before any public launch." />
      <div className="mx-auto max-w-3xl space-y-8 px-4 py-12 lg:px-6">
        {d.body.map(([h, p]) => <section key={h}><h2 className="text-lg font-semibold">{h}</h2><p className="mt-2 leading-relaxed text-muted">{p}</p></section>)}
        <p className="text-sm text-subtle">See also: <Link className="text-accent hover:underline" to="/legal/terms">Terms</Link> · <Link className="text-accent hover:underline" to="/legal/privacy">Privacy</Link> · <Link className="text-accent hover:underline" to="/legal/risk">Risk disclosure</Link></p>
      </div>
    </>
  );
}
