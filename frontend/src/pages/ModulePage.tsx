import { CalendarClock, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { NavItem } from "@/components/layout/nav";

const PLANS: Record<string, { summary: string; items: string[] }> = {
  "/markets": { summary: "Multi-asset market data with a common adapter interface.", items: [
    "Asset & instrument registry (crypto, FX, stocks, ETFs)", "Provider adapters + historical OHLCV",
    "Live price streaming over WebSocket", "Candlestick charts, indicators, watchlists",
    "Session calendars, corporate actions, stale-data protection"] },
  "/ai-trading": { summary: "Autonomous paper execution under an independent risk gate.", items: [
    "Start / pause / stop autonomous execution", "Strategy selection per account",
    "Order lifecycle with idempotent submission", "Global emergency shutdown with explicit restart authorisation"] },
  "/research": { summary: "Evidence-based research with citations and uncertainty.", items: [
    "News, filings and economic-calendar ingestion", "Extraction, chunking, pgvector retrieval",
    "Specialist agents with structured outputs", "Research chat that separates verified facts from interpretation"] },
  "/strategies": { summary: "Strategy research with realistic, cost-aware backtesting.", items: [
    "Event-driven simulator (spread, slippage, fees, delays, closures)", "Walk-forward & out-of-sample validation",
    "Model registry with champion/challenger promotion", "Concept-drift monitoring"] },
  "/portfolio": { summary: "Positions, exposure and returns derived from the ledger.", items: [
    "Open and closed positions", "Allocation and correlation exposure", "Portfolio snapshots and returns"] },
  "/risk": { summary: "Independent risk controller with final authority over every order.", items: [
    "Per-trade risk (dev default 0.5% of equity)", "Daily loss (2%) and max drawdown (10%) circuit breakers",
    "Max 5 open positions, 50% gross exposure, zero leverage on spot", "Manual kill switch and automatic abnormal-activity halt"] },
  "/history": { summary: "Full decision provenance for every order.", items: [
    "Orders, fills, fees and slippage", "Linked AI proposal, evidence and risk decision", "Exportable audit reports"] },
  "/analytics": { summary: "Objective performance evaluation.", items: [
    "Equity curve and drawdown", "Sharpe, Sortino, profit factor, turnover", "Model calibration and drift response"] },
};

export function ModulePage({ item }: { item: NavItem }) {
  const plan = PLANS[item.to];
  return (
    <Card className="mx-auto max-w-3xl">
      <CardHeader title={<span className="flex items-center gap-2"><item.icon className="size-4 text-accent" />{item.label}</span>}
        description={plan?.summary ?? item.description}
        action={<Badge tone="info"><CalendarClock className="size-3" />Phase {item.phase}</Badge>} />
      <CardBody>
        <p className="text-sm text-muted">This module is not part of the Foundation release. It is scheduled for Phase {item.phase} and will ship only once its tests pass.</p>
        <ul className="mt-4 space-y-2">
          {plan?.items.map((i) => (
            <li key={i} className="flex items-start gap-2 text-sm"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-subtle" />{i}</li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
