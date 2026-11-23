/**
 * API client.
 * - Access token lives in memory only (never localStorage).
 * - Refresh token is an httpOnly cookie scoped to /api/v1/auth.
 * - Refresh calls are de-duplicated: the server rotates refresh tokens and treats a
 *   replayed token as theft, so two parallel refreshes would log the user out.
 */
export const API_BASE = "/api/v1";
export const isDemo = import.meta.env.VITE_DEMO_MODE === "true";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Real network in normal builds; the in-browser demo server in the GitHub Pages build. */
async function transport(url: string, init: RequestInit): Promise<Response> {
  if (isDemo) {
    const { demoFetch } = await import("./demo/server");
    return demoFetch(url, init);
  }
  return fetch(url, init);
}

let accessToken: string | null = null;
let refreshInFlight: Promise<TokenResponse | null> | null = null;
let onSessionLost: (() => void) | null = null;

export const tokenStore = {
  set: (t: string | null) => { accessToken = t; },
  get: () => accessToken,
  onSessionLost: (cb: () => void) => { onSessionLost = cb; },
};

async function parse(res: Response) {
  if (res.status === 204) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = body?.error;
    throw new ApiError(res.status, err?.code ?? "http_error", err?.message ?? res.statusText, err?.details);
  }
  return body;
}

export function refreshSession(): Promise<TokenResponse | null> {
  if (!refreshInFlight) {
    refreshInFlight = transport(`${API_BASE}/auth/refresh`, { method: "POST", credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) return null;
        const data = (await res.json()) as TokenResponse;
        accessToken = data.access_token;
        return data;
      })
      .catch(() => null)
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown; idempotencyKey?: string } = {},
  retry = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  if (init.idempotencyKey) headers.set("Idempotency-Key", init.idempotencyKey);
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const res = await transport(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: "same-origin",
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  if (res.status === 401 && retry && !path.startsWith("/auth/")) {
    const refreshed = await refreshSession();
    if (refreshed) return api<T>(path, init, false);
    accessToken = null;
    onSessionLost?.();
  }
  return parse(res) as Promise<T>;
}

// ---- Types mirrored from the backend schemas -------------------------------
export type Role = "admin" | "user";

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface TokenResponse {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  user: User;
}

export interface TradingAccount {
  id: string;
  name: string;
  mode: "PAPER";
  base_currency: string;
  status: "ACTIVE" | "CLOSED";
  created_at: string;
  cash_balance: string;
  equity: string;
}

export interface BalanceLine { code: string; name: string; type: string; currency: string; balance: string }
export interface AccountBalances {
  trading_account_id: string;
  currency: string;
  cash: string;
  investments: string;
  equity: string;
  lines: BalanceLine[];
  ledger_balanced: boolean;
}

export interface LedgerEntry { ledger_code: string; direction: "DEBIT" | "CREDIT"; amount: string; currency: string }
export interface LedgerTransaction {
  id: string;
  type: string;
  description: string;
  created_at: string;
  created_by: string | null;
  entries: LedgerEntry[];
}

export interface Page<T> { items: T[]; total: number; limit: number; offset: number }

export interface AuditLog {
  id: number;
  occurred_at: string;
  actor_user_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  outcome: "success" | "failure";
  ip_address: string | null;
  request_id: string | null;
  details: Record<string, unknown>;
  hash: string;
}

export interface UserSettings { timezone: string; base_currency: string; theme: string; updated_at: string }

export interface SystemInfo {
  name: string;
  version: string;
  environment: string;
  trading_mode: "PAPER";
  live_trading_enabled: boolean;
  registration_open: boolean;
  supported_currencies: string[];
}

// ---- Market data (Phase 3) -------------------------------------------------
export type AssetClass = "CRYPTO" | "FX" | "STOCK" | "ETF";

export interface Instrument {
  symbol: string;
  slug: string;
  display_name: string;
  asset_class: AssetClass;
  instrument_type: "SPOT" | "SPOT_FX" | "SHARE" | "ETF";
  venue: string;
  market: "CRYPTO_24_7" | "FX_24_5" | "US_EQUITY" | "UK_EQUITY";
  base_currency: string;
  quote_currency: string;
  price_decimals: number;
  tick_size: string;
  lot_size: string;
}

export interface Quote {
  symbol: string;
  last: string;
  bid: string;
  ask: string;
  prev_close: string | null;
  change: string | null;
  change_pct: string | null;
  as_of: string;
  source: string;
  market_open: boolean;
  stale: boolean;
  tradable: boolean;
  age_seconds: number;
}

export interface InstrumentWithQuote { instrument: Instrument; quote: Quote | null }

export interface MarketStatus { market: string; label: string; is_open: boolean; next_change: string | null }

export interface MarketOverview {
  markets: MarketStatus[];
  groups: Record<AssetClass, InstrumentWithQuote[]>;
  data_mode: "synthetic" | "live";
}

export interface Candle { open_time: string; open: string; high: string; low: string; close: string; volume: string }
type Line = (number | null)[];
export interface CandlesResponse {
  symbol: string;
  timeframe: string;
  source: string | null;
  candles: Candle[];
  indicators: Partial<{
    sma20: Line; sma50: Line; ema20: Line; ema50: Line; rsi14: Line;
    bb20: { upper: Line; middle: Line; lower: Line };
    macd: { macd: Line; signal: Line; histogram: Line };
  }>;
}

export interface Watchlist { id: string; name: string; items: InstrumentWithQuote[] }

// ---- Research (Phase 4) ------------------------------------------------------
export type DocType = "earnings" | "filing" | "central_bank" | "economic_data" | "news" | "analysis" | "other";

export interface ResearchDocument {
  id: string;
  title: string;
  source_name: string;
  source_url: string | null;
  doc_type: DocType;
  content_type: string;
  published_at: string | null;
  retrieved_at: string;
  word_count: number;
  page_count: number | null;
  symbols: string[];
  sentiment: number;
  is_sample: boolean;
}
export interface ResearchChunk { id: string; ordinal: number; text: string; page: number | null; paragraph: number; sentiment: number }
export interface ResearchDocumentDetail extends ResearchDocument { chunks: ResearchChunk[] }
export interface IngestResult { created: number; duplicates: number; documents: ResearchDocument[] }

export interface SearchHit {
  chunk_id: string; document: ResearchDocument; text: string; page: number | null;
  paragraph: number; score: number; stale: boolean;
}

export interface ReportClaim { statement: string; citations: number[]; quote: string; verified: boolean }
export interface ReportSource {
  n: number; document_id: string; chunk_id: string; title: string; source_name: string;
  source_url: string | null; doc_type: DocType; published_at: string | null; retrieved_at: string;
  page: number | null; paragraph: number; age_days: number | null; stale: boolean;
  stale_after_days: number; is_sample: boolean; relevance: number; sentiment: number; excerpt: string;
}
export interface ReportBody {
  question: string;
  generated_at: string;
  engine: string;
  insufficient_evidence: boolean;
  facts: ReportClaim[];
  interpretation: { text: string; basis: "system" | "model"; label: string } | null;
  contradictions: ReportClaim[];
  open_questions: string[];
  confidence: { score: number; label: "low" | "medium" | "high"; factors: Record<string, number>; method: string };
  sources: ReportSource[];
  validation: { claims_proposed: number; claims_verified: number; claims_rejected: number; rejected: { statement: string; reason: string }[] };
  warnings: string[];
  disclaimer: string;
}
export interface ReportSummary {
  id: string; question: string; symbols: string[]; engine: string; confidence: number;
  insufficient_evidence: boolean; created_at: string;
}
export interface ResearchReport extends ReportSummary { body: ReportBody; latency_ms: number }

export interface ResearchStatus {
  engine: "extractive" | "claude"; model: string | null; embedding_model: string;
  documents: number; chunks: number; url_ingestion_enabled: boolean;
}

// ---- AI agents (Phase 5) ----------------------------------------------------------
export interface AIAgent { name: string; display_name: string; role: string; kind: "directional" | "gate"; weight: number; enabled: boolean; version: string }
export interface AgentEvidence { label: string; value: string; detail: string }
export interface AgentFinding {
  agent: string; status: "ok" | "abstain" | "error"; direction: -1 | 0 | 1; score: number;
  confidence: number; summary: string; evidence: AgentEvidence[]; duration_ms: number;
}
export interface TradeProposal {
  id: string; run_id: string; account_id: string; symbol: string; direction: "BUY" | "SELL";
  strategy_id: string; entry_type: string; entry_price: string; stop_loss: string; take_profit: string;
  quantity: string; notional: string; risk_amount: string; account_currency: string; confidence: number;
  reward_risk: number; invalidation_conditions: string[]; risk_check_required: boolean;
  status: "PENDING_RISK_REVIEW" | "DISMISSED"; effective_status: "PENDING_RISK_REVIEW" | "DISMISSED" | "EXPIRED";
  expires_at: string; created_at: string; dismissed_at: string | null;
}
export interface RunSummary {
  id: string; symbol: string; decision: "BUY" | "NO_TRADE"; bias: "bullish" | "bearish" | "neutral";
  net_score: number; agreement: number; coverage: number; confidence: number; created_at: string; latency_ms: number;
}
export interface AgentRun extends RunSummary {
  account_id: string | null; reasons: string[]; weights: Record<string, number>; context: Record<string, unknown>;
  started_at: string; finished_at: string; findings: AgentFinding[]; proposal: TradeProposal | null;
}

// ---- Quantitative models (Phase 6) --------------------------------------------------
export interface MLAlgorithm { key: string; label: string; description: string; params: Record<string, unknown> }
export interface MLGate { name: string; passed: boolean; value: string; threshold: string }
export interface MLVersionSummary {
  id: string; model_id: string; symbol: string; version: number; status: "candidate" | "champion" | "retired";
  eligible: boolean; eligibility_note: string; data_source: string; trained_at: string; promoted_at: string | null;
  retired_at: string | null; n_samples: number;
  summary: { auc: number; brier: number; brier_climatology: number; net_return: number; sharpe: number; buy_hold_return: number; trades: number };
}
export interface MLModelSpec { id: string; name: string; symbol: string; timeframe: string; horizon: number; algorithm: string; created_at: string; versions: MLVersionSummary[] }
export interface MLEvaluation { id: string; kind: "walk_forward" | "drift_check"; status: string; metrics: Record<string, any>; created_at: string } // eslint-disable-line @typescript-eslint/no-explicit-any
export interface MLStrategyStats { net_return: number; sharpe: number; max_drawdown: number; trades: number; exposure: number; hit_rate: number; periods: number }
export interface MLOos {
  samples: number; accuracy: number; brier: number; brier_climatology: number; log_loss: number; auc: number; ece: number;
  base_rate: number; cost_per_side: number; threshold: number;
  strategy_net_return: number; strategy_sharpe: number; strategy_max_drawdown: number; strategy_trades: number;
  strategy_exposure: number; strategy_hit_rate: number; strategy_periods: number;
}
export interface MLVersionDetail extends MLVersionSummary {
  gates: MLGate[];
  metrics: {
    horizon: number;
    oos: MLOos;
    baselines: { buy_hold: MLStrategyStats; momentum: MLStrategyStats; climatology: { brier: number } };
    folds: { fold: number; train_size: number; test_size: number; test_from: string; test_to: string; brier: number; brier_climatology: number; net_return: number; buy_hold_return: number; beats_buy_hold: boolean }[];
    calibration: { bin: number; predicted: number; observed: number; count: number }[];
    curves: { times: string[]; model: number[]; buy_hold: number[]; momentum: number[] };
  };
  params: Record<string, unknown>; features: string[]; feature_importance: Record<string, number>;
  train_from: string; train_to: string; artifact_sha256: string;
  model: { name: string; algorithm: string; horizon: number; timeframe: string };
  evaluations: MLEvaluation[];
}

// ---- Backtesting (Phase 7) ---------------------------------------------------------
export interface StrategyInfo { key: string; name: string; description: string; defaults: Record<string, number>; params: Record<string, { type: "int" | "float"; min: number; max: number }>; grid_size: number }
export interface BtMetrics {
  total_return: number; cagr: number; volatility: number; sharpe: number; sortino: number; max_drawdown: number; calmar: number;
  trades: number; win_rate: number; profit_factor: number | null; avg_win: number; avg_loss: number; avg_bars_held: number;
  exposure: number; turnover: number; fees: number; slippage_and_spread: number; halted: boolean; risk_events: number; bars: number;
}
export interface BtTrade { entry_time: string; exit_time: string | null; entry_price: number; exit_price: number | null; qty: number; pnl: number; return: number | null; fees: number; exit_reason: string; bars_held: number | null }
export interface BacktestSummary { id: string; strategy_key: string; symbol: string; days: number; params: Record<string, number>; data_source: string; oos_sharpe: number; oos_return: number; created_at: string; latency_ms: number }
export interface BacktestRun extends BacktestSummary {
  timeframe: string; period_from: string; period_to: string;
  config: { costs: Record<string, number>; risk: Record<string, number>; capital: number; optimise: boolean; asset_class: string };
  result: {
    params: Record<string, number>; optimised: boolean; split_time: string;
    in_sample: { strategy: BtMetrics; buy_hold: BtMetrics }; out_of_sample: { strategy: BtMetrics; buy_hold: BtMetrics }; full: BtMetrics;
    degradation: { sharpe: number; total_return: number };
    grid: { params: Record<string, number>; sharpe: number; total_return: number; max_drawdown: number; trades: number }[];
    warnings: string[]; curves: { strategy: [string, number][]; buy_hold: [string, number][] };
    trades: BtTrade[]; events: { time: string; type: string; detail: string }[];
  };
}
