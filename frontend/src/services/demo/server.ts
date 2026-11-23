/**
 * In-browser implementation of the AUREX REST API for the static GitHub Pages demo.
 *
 * It mirrors the backend's contract and business rules (validation, double-entry
 * postings, idempotency, audit hash chain, RBAC) so the real UI runs unchanged.
 * Everything is stored in this browser's localStorage — it is a demonstration, not
 * a security boundary, and no data leaves the device.
 */
import { fromUnits, toUnits } from "@/lib/utils";
import { INSTRUMENTS } from "./instruments";
import * as mkt from "./market";
import * as rs from "./research";
import * as ag from "./agents";

const KEY = "aurex-demo-v1";
const REFRESH_KEY = "aurex-demo-refresh";
const MAX_BALANCE = toUnits("10000000");
const MONEY_RE = /^\d+(\.\d{1,8})?$/;
const CURRENCIES = ["USD", "GBP", "EUR"];
const CHART: [string, string, string][] = [
  ["CASH", "ASSET", "Cash"], ["INVESTMENTS", "ASSET", "Investments at cost"],
  ["OPENING_EQUITY", "EQUITY", "Opening equity"], ["CAPITAL_CONTRIBUTIONS", "EQUITY", "Capital contributions"],
  ["CAPITAL_WITHDRAWALS", "EQUITY", "Capital withdrawals"], ["REALISED_PNL", "INCOME", "Realised profit and loss"],
  ["FEES", "EXPENSE", "Trading fees"],
];
const DEBIT_NORMAL = new Set(["ASSET", "EXPENSE"]);

interface DUser { id: string; email: string; full_name: string; pw: string; salt: string; role: "admin" | "user"; is_active: boolean; created_at: string; last_login_at: string | null }
interface DSession { id: string; user_id: string; access: string; refresh: string; family: string; revoked: string | null; reason: string | null }
interface DEntry { ledger_code: string; direction: "DEBIT" | "CREDIT"; amount: string; currency: string }
interface DTxn { id: string; account_id: string; type: string; description: string; created_at: string; created_by: string; idem: string | null; entries: DEntry[] }
interface DAccount { id: string; owner_id: string; name: string; mode: "PAPER"; base_currency: string; status: "ACTIVE"; created_at: string }
interface DAudit { id: number; occurred_at: string; actor_user_id: string | null; action: string; resource_type: string | null; resource_id: string | null; outcome: string; ip_address: string | null; request_id: string | null; details: Record<string, unknown>; prev_hash: string; hash: string }
interface State {
  users: DUser[]; sessions: DSession[]; accounts: DAccount[]; txns: DTxn[]; audit: DAudit[];
  settings: Record<string, { timezone: string; base_currency: string; theme: string; updated_at: string }>;
  watchlists: Record<string, string[]>;
  docs: rs.DDoc[];
  chunks: rs.DChunk[];
  aiRuns: Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  aiAgents: Record<string, { enabled: boolean; weight: number }>;
  reports: { id: string; user_id: string; question: string; symbols: string[]; engine: string; confidence: number; insufficient_evidence: boolean; created_at: string; latency_ms: number; body: unknown }[];
}

let memory: State | null = null;
function load(): State {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      memory = JSON.parse(raw) as State;
      memory.docs ??= []; memory.chunks ??= []; memory.reports ??= []; // states saved by older demo builds
      memory.aiRuns ??= []; memory.aiAgents ??= {};
      return memory;
    }
  } catch { /* storage unavailable: fall back to memory */ }
  return (memory = { users: [], sessions: [], accounts: [], txns: [], audit: [], settings: {}, watchlists: {}, docs: [], chunks: [], reports: [], aiRuns: [], aiAgents: {} });
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* ignore */ } }
const refreshStore = {
  get: () => { try { return localStorage.getItem(REFRESH_KEY); } catch { return null; } },
  set: (v: string | null) => { try { if (v) localStorage.setItem(REFRESH_KEY, v); else localStorage.removeItem(REFRESH_KEY); } catch { /* ignore */ } },
};

const now = () => new Date().toISOString();
const uuid = (): string => crypto.randomUUID();
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
const bad = (msg: string, field = "body") => new HttpError(422, "validation_error", "Request validation failed", [{ loc: [field], msg, type: "value_error" }]);

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

// ---- audit -------------------------------------------------------------------------
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
const auditRecord = (a: DAudit) => ({ occurred_at: a.occurred_at, actor_user_id: a.actor_user_id, action: a.action, resource_type: a.resource_type, resource_id: a.resource_id, outcome: a.outcome, ip_address: a.ip_address, request_id: a.request_id, details: a.details });
async function audit(s: State, actor: string | null, action: string, opts: { type?: string; id?: string; outcome?: string; details?: Record<string, unknown> } = {}) {
  const prev = s.audit.length ? s.audit[s.audit.length - 1]!.hash : "0".repeat(64);
  const a: DAudit = {
    id: s.audit.length + 1, occurred_at: now(), actor_user_id: actor, action, resource_type: opts.type ?? null,
    resource_id: opts.id ?? null, outcome: opts.outcome ?? "success", ip_address: "browser", request_id: null,
    details: JSON.parse(JSON.stringify(opts.details ?? {})), prev_hash: prev, hash: "",
  };
  a.hash = await sha256(prev + canonical(auditRecord(a)));
  s.audit.push(a);
}

// ---- helpers -----------------------------------------------------------------------
function validatePassword(pw: unknown, field = "password") {
  if (typeof pw !== "string" || pw.length < 12) throw bad("Password must be at least 12 characters", field);
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) throw bad("Password must contain at least three of: lowercase, uppercase, digit, symbol", field);
}
const userRead = (u: DUser) => ({ id: u.id, email: u.email, full_name: u.full_name, role: u.role, is_active: u.is_active, created_at: u.created_at, last_login_at: u.last_login_at });

function balances(s: State, acct: DAccount) {
  const net = new Map<string, bigint>();
  for (const t of s.txns) if (t.account_id === acct.id) for (const e of t.entries) {
    net.set(e.ledger_code, (net.get(e.ledger_code) ?? 0n) + (e.direction === "DEBIT" ? toUnits(e.amount) : -toUnits(e.amount)));
  }
  const lines = CHART.map(([code, type, name]) => {
    const n = net.get(code) ?? 0n;
    return { code, name, type, currency: acct.base_currency, balance: fromUnits(DEBIT_NORMAL.has(type) ? n : -n), _net: n };
  }).sort((a, b) => a.code.localeCompare(b.code));
  const assets = lines.filter((l) => l.type === "ASSET").reduce((a, l) => a + toUnits(l.balance), 0n);
  const liab = lines.filter((l) => l.type === "LIABILITY").reduce((a, l) => a + toUnits(l.balance), 0n);
  const get = (c: string) => lines.find((l) => l.code === c)!.balance;
  return { lines, cash: get("CASH"), investments: get("INVESTMENTS"), equity: fromUnits(assets - liab), balanced: lines.reduce((a, l) => a + l._net, 0n) === 0n };
}
function accountRead(s: State, a: DAccount) {
  const b = balances(s, a);
  return { ...a, cash_balance: b.cash, equity: b.equity };
}
function post(s: State, acct: DAccount, type: string, legs: [string, "DEBIT" | "CREDIT", string][], user: string, description = "", idem: string | null = null) {
  const deb = legs.filter((l) => l[1] === "DEBIT").reduce((a, l) => a + toUnits(l[2]), 0n);
  const cred = legs.filter((l) => l[1] === "CREDIT").reduce((a, l) => a + toUnits(l[2]), 0n);
  if (deb !== cred) throw new HttpError(400, "ledger_imbalance", "Ledger transaction must balance (debits == credits)");
  const t: DTxn = { id: uuid(), account_id: acct.id, type, description, created_at: now(), created_by: user, idem,
    entries: legs.map(([c, d, a]) => ({ ledger_code: c, direction: d, amount: fromUnits(toUnits(a)), currency: acct.base_currency })) };
  s.txns.push(t);
  return t;
}
const txnRead = (t: DTxn) => ({ id: t.id, type: t.type, description: t.description, created_at: t.created_at, created_by: t.created_by,
  entries: [...t.entries].sort((a, b) => (a.direction === b.direction ? 0 : a.direction === "DEBIT" ? -1 : 1)) });
function money(v: unknown) {
  const str = typeof v === "number" ? String(v) : v;
  if (typeof str !== "string" || !MONEY_RE.test(str) || toUnits(str) <= 0n) throw bad("Amount must be greater than zero with at most 8 decimal places", "amount");
  return str;
}

// ---- markets --------------------------------------------------------------------------
const slug = (s: string) => s.replace("/", "");
const instRead = (i: mkt.DemoInstrument) => { const { reference_price: _r, ...rest } = i; return { ...rest, slug: slug(i.symbol) }; };
function findInst(sym: string) {
  const k = decodeURIComponent(sym).toUpperCase().replace("/", "");
  const i = INSTRUMENTS.find((x) => slug(x.symbol).toUpperCase() === k);
  if (!i) throw new HttpError(404, "not_found", `Unknown instrument ${sym}`);
  return i;
}
const withQuote = (i: mkt.DemoInstrument) => ({ instrument: instRead(i), quote: mkt.quote(i) });
const LABELS: Record<string, string> = { CRYPTO_24_7: "Crypto (24/7)", FX_24_5: "Forex (24/5)", US_EQUITY: "US equities (NYSE/Nasdaq)", UK_EQUITY: "UK equities (LSE)" };
const marketStatuses = () => Object.entries(LABELS).map(([m, label]) => {
  const st = mkt.status(m as mkt.MarketKey, Date.now());
  return { market: m, label, is_open: st.is_open, next_change: st.next_change ? new Date(st.next_change).toISOString() : null };
});
function watchlist(s: State, userId: string) {
  s.watchlists[userId] ??= ["BTC-USD", "EUR/USD", "AAPL", "SPY"];
  return { id: `wl-${userId}`, name: "Default", items: s.watchlists[userId]!.map((sym) => withQuote(findInst(sym))) };
}

// ---- router ---------------------------------------------------------------------------
type Ctx = { s: State; body: Record<string, unknown>; headers: Headers; params: string[]; query: URLSearchParams; form?: FormData };
type Handler = (c: Ctx) => Promise<Response> | Response;

function authUser(c: Ctx): { user: DUser; session: DSession } {
  const t = c.headers.get("Authorization")?.replace(/^Bearer /, "");
  const session = c.s.sessions.find((x) => x.access === t && !x.revoked);
  const user = session && c.s.users.find((u) => u.id === session.user_id);
  if (!session || !user || !user.is_active) throw new HttpError(401, "unauthorized", "Authentication required");
  return { user, session };
}
function admin(c: Ctx) {
  const a = authUser(c);
  if (a.user.role !== "admin") throw new HttpError(403, "forbidden", "Administrator role required");
  return a;
}
function ownedAccount(c: Ctx, id: string) {
  const { user } = authUser(c);
  const a = c.s.accounts.find((x) => x.id === id && x.owner_id === user.id);
  if (!a) throw new HttpError(404, "not_found", "Trading account not found");
  return { user, a };
}
function issue(s: State, user: DUser, family = uuid()) {
  const sess: DSession = { id: uuid(), user_id: user.id, access: token(), refresh: token(), family, revoked: null, reason: null };
  s.sessions.push(sess);
  refreshStore.set(sess.refresh);
  return { access_token: sess.access, token_type: "bearer", expires_in: 900, user: userRead(user) };
}

async function movement(c: Ctx, kind: "VIRTUAL_DEPOSIT" | "VIRTUAL_WITHDRAWAL") {
  const { user, a } = ownedAccount(c, c.params[0]!);
  const amount = money(c.body.amount);
  const idem = c.headers.get("Idempotency-Key");
  if (idem) {
    const prev = c.s.txns.find((t) => t.account_id === a.id && t.idem === idem);
    if (prev) {
      const cash = prev.entries.find((e) => e.ledger_code === "CASH")!;
      if (prev.type !== kind || toUnits(cash.amount) !== toUnits(amount)) throw new HttpError(409, "conflict", "Idempotency key reused with a different request");
      return json(200, txnRead(prev), { "Idempotent-Replay": "true" });
    }
  }
  const cash = toUnits(balances(c.s, a).cash);
  let t: DTxn;
  if (kind === "VIRTUAL_DEPOSIT") {
    if (cash + toUnits(amount) > MAX_BALANCE) throw new HttpError(422, "business_rule_violation", "Virtual cash may not exceed 10000000");
    t = post(c.s, a, kind, [["CASH", "DEBIT", amount], ["CAPITAL_CONTRIBUTIONS", "CREDIT", amount]], user.id, String(c.body.description ?? ""), idem);
  } else {
    if (toUnits(amount) > cash) throw new HttpError(422, "business_rule_violation", "Insufficient virtual cash", { available: fromUnits(cash), requested: amount });
    t = post(c.s, a, kind, [["CAPITAL_WITHDRAWALS", "DEBIT", amount], ["CASH", "CREDIT", amount]], user.id, String(c.body.description ?? ""), idem);
  }
  await audit(c.s, user.id, kind === "VIRTUAL_DEPOSIT" ? "wallet.deposit" : "wallet.withdraw", { type: "trading_account", id: a.id, details: { amount, currency: a.base_currency, ledger_transaction_id: t.id } });
  return json(201, txnRead(t));
}

// ---- research ---------------------------------------------------------------------------
const ALIASES: Record<string, string[]> = Object.fromEntries(INSTRUMENTS.map((i) => {
  const names = new Set([i.symbol, slug(i.symbol)]);
  if (i.asset_class === "CRYPTO") { names.add(i.base_currency); names.add(i.display_name.split(" /")[0]!); }
  if (i.asset_class === "STOCK" || i.asset_class === "ETF") { names.add(i.display_name); names.add(i.symbol.split(".")[0]!); }
  return [i.symbol, [...names].sort((a, b) => b.length - a.length)];
}));
const docRead = (d: rs.DDoc) => { const { content_hash: _h, ...rest } = d; return rest; };

async function ingest(s: State, input: { title: string; text: string; source_name: string; source_url?: string | null; published_at?: string | null; doc_type?: string | null; content_type: string; is_sample?: boolean }): Promise<[rs.DDoc, boolean]> {
  const text = rs.normalise(input.text);
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 5) throw new HttpError(422, "business_rule_violation", "Document has too little text to index");
  if (input.doc_type && !rs.DOC_TYPES.includes(input.doc_type)) throw bad(`doc_type must be one of ${rs.DOC_TYPES.join(", ")}`, "doc_type");
  const hash = await sha256(text);
  const existing = s.docs.find((d) => d.content_hash === hash);
  if (existing) return [existing, false];
  const title = input.title.slice(0, 300).trim() || "(untitled)";
  const doc: rs.DDoc = {
    id: uuid(), title, source_name: input.source_name.slice(0, 120), source_url: input.source_url ?? null,
    doc_type: input.doc_type || rs.classify(title, text), content_type: input.content_type,
    published_at: input.published_at ?? null, retrieved_at: now(), content_hash: hash, word_count: words, page_count: null,
    symbols: rs.tagInstruments(`${title}\n${text}`, ALIASES), sentiment: rs.sentiment(text), is_sample: !!input.is_sample,
  };
  s.docs.push(doc);
  for (const c of rs.chunk(text)) {
    s.chunks.push({ id: uuid(), document_id: doc.id, ordinal: c.ordinal, text: c.text, page: null, paragraph: c.paragraph, sentiment: rs.sentiment(c.text), embedding: rs.embed(`${title}\n${c.text}`) });
  }
  return [doc, true];
}
async function finishIngest(s: State, user: DUser, results: [rs.DDoc, boolean][], via: string) {
  for (const [d, created] of results) if (created) await audit(s, user.id, "research.document.add", { type: "research_document", id: d.id, details: { title: d.title, via } });
  return json(201, { created: results.filter((r) => r[1]).length, duplicates: results.filter((r) => !r[1]).length, documents: results.map(([d]) => docRead(d)) });
}
async function loadSamples(s: State) {
  let created = 0;
  for (const [title, type, age, text] of rs.SAMPLES) {
    const [, isNew] = await ingest(s, { title, text, source_name: rs.SAMPLE_SOURCE, published_at: new Date(Date.now() - age * 86_400_000).toISOString(), doc_type: type, content_type: "text/plain", is_sample: true });
    created += +isNew;
  }
  return created;
}
const reportSummary = (r: State["reports"][number]) => { const { body: _b, user_id: _u, latency_ms: _l, ...rest } = r; return rest; };

// ---- agents -------------------------------------------------------------------------------
const AGENT_META: [string, string, "directional" | "gate", string][] = [
  ["technical", "Technical Agent", "directional", "Trend, momentum and volatility from hourly OHLCV (SMA, RSI, MACD, Bollinger, ATR)."],
  ["quant", "Quant Agent", "directional", "Statistical drift estimate with a forecast interval and mean-reversion check."],
  ["fundamental", "Fundamental Agent", "directional", "Earnings and filings evidence for shares and ETFs."],
  ["news", "News Agent", "directional", "Recent instrument news/analysis tone and high-impact event windows."],
  ["sentiment", "Sentiment Agent", "directional", "30-day research tone for the instrument."],
  ["regime", "Regime Agent", "gate", "Volatility regime, trend efficiency and distribution-drift (KS) gate."],
  ["portfolio", "Portfolio Agent", "gate", "Position sizing at 0.5% risk of equity, no leverage, exposure caps."],
  ["risk", "Risk Agent", "gate", "Advisory pre-check: market state, staleness, spread, events, limits. The independent risk gate has final authority."],
];
const agentList = (s: State) => AGENT_META.map(([name, display_name, kind, role]) => ({
  name, display_name, kind, role, version: "1.0",
  weight: s.aiAgents[name]?.weight ?? ag.DEFAULT_WEIGHTS[name] ?? 0, enabled: s.aiAgents[name]?.enabled ?? true,
}));
function lastPrice(sym: string) { const i = INSTRUMENTS.find((x) => x.symbol === sym); return i ? +mkt.quote(i).last : null; }
function fxRate(src: string, dst: string): number | null {
  if (src === dst) return 1;
  const rate = (a: string, b: string) => { const d = lastPrice(`${a}/${b}`); if (d) return d; const inv = lastPrice(`${b}/${a}`); return inv ? 1 / inv : null; };
  const direct = rate(src, dst); if (direct) return direct;
  const x = rate(src, "USD"), y = rate("USD", dst);
  return x != null && y != null ? x * y : null;
}
const withEffective = (p: Record<string, unknown> | null) => p && ({ ...p, effective_status: p.status === "PENDING_RISK_REVIEW" && Date.parse(p.expires_at as string) <= Date.now() ? "EXPIRED" : p.status });
const runSummary = (r: Record<string, unknown>) => ({ id: r.id, symbol: r.symbol, decision: r.decision, bias: r.bias, net_score: r.net_score, agreement: r.agreement, coverage: r.coverage, confidence: r.confidence, created_at: r.created_at, latency_ms: r.latency_ms });

const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/system\/health$/, () => json(200, { status: "ok", database: "ok" })],
  ["GET", /^\/system\/info$/, () => json(200, { name: "AUREX AI", version: "0.2.0-demo", environment: "demo", trading_mode: "PAPER", live_trading_enabled: false, registration_open: true, supported_currencies: CURRENCIES })],

  ["POST", /^\/auth\/register$/, async ({ s, body }) => {
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("value is not a valid email address", "email");
    const name = String(body.full_name ?? "").trim();
    if (!name) throw bad("Name is required", "full_name");
    validatePassword(body.password);
    if (s.users.some((u) => u.email === email)) throw new HttpError(409, "conflict", "An account with this email already exists");
    const salt = token().slice(0, 16);
    // First account in this browser becomes the administrator so every screen can be explored.
    const user: DUser = { id: uuid(), email, full_name: name, pw: await sha256(salt + body.password), salt, role: s.users.length === 0 ? "admin" : "user", is_active: true, created_at: now(), last_login_at: null };
    s.users.push(user);
    await audit(s, user.id, "auth.register", { type: "user", id: user.id });
    return json(201, userRead(user));
  }],
  ["POST", /^\/auth\/login$/, async ({ s, body }) => {
    const email = String(body.email ?? "").toLowerCase();
    const u = s.users.find((x) => x.email === email);
    if (!u || (await sha256(u.salt + String(body.password ?? ""))) !== u.pw) {
      await audit(s, null, "auth.login", { outcome: "failure", type: "user", id: u?.id, details: { email, reason: "invalid_credentials" } });
      save();
      throw new HttpError(401, "unauthorized", "Invalid email or password");
    }
    if (!u.is_active) throw new HttpError(403, "forbidden", "This account has been disabled");
    u.last_login_at = now();
    const res = issue(s, u);
    await audit(s, u.id, "auth.login", { type: "user", id: u.id });
    return json(200, res);
  }],
  ["POST", /^\/auth\/refresh$/, ({ s }) => {
    const rt = refreshStore.get();
    const sess = s.sessions.find((x) => x.refresh === rt);
    if (!sess || sess.revoked) throw new HttpError(401, "unauthorized", "Invalid refresh token");
    const user = s.users.find((u) => u.id === sess.user_id);
    if (!user?.is_active) throw new HttpError(401, "unauthorized", "Account unavailable");
    sess.revoked = now(); sess.reason = "rotated";
    return json(200, issue(s, user, sess.family));
  }],
  ["POST", /^\/auth\/logout$/, async ({ s }) => {
    const sess = s.sessions.find((x) => x.refresh === refreshStore.get());
    if (sess && !sess.revoked) { sess.revoked = now(); sess.reason = "logout"; await audit(s, sess.user_id, "auth.logout", { type: "user_session", id: sess.id }); }
    refreshStore.set(null);
    return json(204, null);
  }],
  ["GET", /^\/auth\/me$/, (c) => json(200, userRead(authUser(c).user))],
  ["POST", /^\/auth\/password$/, async (c) => {
    const { user, session } = authUser(c);
    validatePassword(c.body.new_password, "new_password");
    if ((await sha256(user.salt + String(c.body.current_password ?? ""))) !== user.pw) throw new HttpError(401, "unauthorized", "Current password is incorrect");
    user.pw = await sha256(user.salt + c.body.new_password);
    for (const x of c.s.sessions) if (x.user_id === user.id && x.id !== session.id && !x.revoked) { x.revoked = now(); x.reason = "password_changed"; }
    await audit(c.s, user.id, "auth.password_change", { type: "user", id: user.id });
    return json(204, null);
  }],

  ["GET", /^\/users\/me\/settings$/, (c) => {
    const { user } = authUser(c);
    c.s.settings[user.id] ??= { timezone: "Europe/London", base_currency: "USD", theme: "dark", updated_at: now() };
    return json(200, c.s.settings[user.id]);
  }],
  ["PATCH", /^\/users\/me\/settings$/, async (c) => {
    const { user } = authUser(c);
    const cur = (c.s.settings[user.id] ??= { timezone: "Europe/London", base_currency: "USD", theme: "dark", updated_at: now() });
    const changes: Record<string, string> = {};
    if (c.body.timezone) {
      try { new Intl.DateTimeFormat("en", { timeZone: String(c.body.timezone) }); } catch { throw bad("Unknown IANA timezone", "timezone"); }
      changes.timezone = String(c.body.timezone);
    }
    if (c.body.base_currency) { if (!CURRENCIES.includes(String(c.body.base_currency))) throw bad("Unsupported currency", "base_currency"); changes.base_currency = String(c.body.base_currency); }
    Object.assign(cur, changes, { updated_at: now() });
    if (Object.keys(changes).length) await audit(c.s, user.id, "user.settings.update", { type: "user", id: user.id, details: changes });
    return json(200, cur);
  }],
  ["GET", /^\/users\/me\/activity$/, (c) => {
    const { user } = authUser(c);
    return json(200, c.s.audit.filter((a) => a.actor_user_id === user.id).slice(-Number(c.query.get("limit") ?? 20)).reverse());
  }],

  ["GET", /^\/accounts$/, (c) => { const { user } = authUser(c); return json(200, c.s.accounts.filter((a) => a.owner_id === user.id).map((a) => accountRead(c.s, a))); }],
  ["POST", /^\/accounts$/, async (c) => {
    const { user } = authUser(c);
    const name = String(c.body.name ?? "").trim();
    if (!name) throw bad("Name is required", "name");
    const ccy = String(c.body.base_currency ?? "USD").toUpperCase();
    if (!CURRENCIES.includes(ccy)) throw new HttpError(422, "business_rule_violation", `Unsupported currency. Supported: ${CURRENCIES.join(", ")}`);
    const start = c.body.starting_balance == null ? "100000" : money(c.body.starting_balance);
    if (toUnits(start) > MAX_BALANCE) throw new HttpError(422, "business_rule_violation", "Starting balance exceeds the virtual maximum of 10000000");
    if (c.s.accounts.filter((a) => a.owner_id === user.id).length >= 10) throw new HttpError(422, "business_rule_violation", "Maximum number of paper accounts reached");
    const a: DAccount = { id: uuid(), owner_id: user.id, name, mode: "PAPER", base_currency: ccy, status: "ACTIVE", created_at: now() };
    c.s.accounts.push(a);
    const t = post(c.s, a, "INITIAL_FUNDING", [["CASH", "DEBIT", start], ["OPENING_EQUITY", "CREDIT", start]], user.id, "Initial virtual funding");
    await audit(c.s, user.id, "account.paper.create", { type: "trading_account", id: a.id, details: { name, currency: ccy, starting_balance: start, ledger_transaction_id: t.id } });
    return json(201, accountRead(c.s, a));
  }],
  ["GET", /^\/accounts\/([\w-]+)$/, (c) => json(200, accountRead(c.s, ownedAccount(c, c.params[0]!).a))],
  ["GET", /^\/accounts\/([\w-]+)\/balances$/, (c) => {
    const { a } = ownedAccount(c, c.params[0]!);
    const b = balances(c.s, a);
    return json(200, { trading_account_id: a.id, currency: a.base_currency, cash: b.cash, investments: b.investments, equity: b.equity, ledger_balanced: b.balanced, lines: b.lines.map(({ _net, ...l }) => l) });
  }],
  ["GET", /^\/accounts\/([\w-]+)\/ledger$/, (c) => {
    const { a } = ownedAccount(c, c.params[0]!);
    const limit = Number(c.query.get("limit") ?? 50); const offset = Number(c.query.get("offset") ?? 0);
    const all = c.s.txns.filter((t) => t.account_id === a.id).reverse();
    return json(200, { items: all.slice(offset, offset + limit).map(txnRead), total: all.length, limit, offset });
  }],
  ["POST", /^\/accounts\/([\w-]+)\/deposits$/, (c) => movement(c, "VIRTUAL_DEPOSIT")],
  ["POST", /^\/accounts\/([\w-]+)\/withdrawals$/, (c) => movement(c, "VIRTUAL_WITHDRAWAL")],

  ["GET", /^\/admin\/users$/, (c) => { admin(c); return json(200, { items: c.s.users.map(userRead), total: c.s.users.length, limit: 200, offset: 0 }); }],
  ["PATCH", /^\/admin\/users\/([\w-]+)$/, async (c) => {
    const { user: me } = admin(c);
    const t = c.s.users.find((u) => u.id === c.params[0]);
    if (!t) throw new HttpError(404, "not_found", "User not found");
    if (t.id === me.id && (c.body.role === "user" || c.body.is_active === false)) throw new HttpError(422, "business_rule_violation", "Administrators cannot demote or disable themselves");
    const changes: Record<string, unknown> = {};
    if (c.body.role && c.body.role !== t.role) { t.role = c.body.role as DUser["role"]; changes.role = t.role; }
    if (typeof c.body.is_active === "boolean" && c.body.is_active !== t.is_active) { t.is_active = c.body.is_active; changes.is_active = t.is_active; }
    if (Object.keys(changes).length) {
      for (const x of c.s.sessions) if (x.user_id === t.id && !x.revoked) { x.revoked = now(); x.reason = "admin_update"; }
      await audit(c.s, me.id, "admin.user.update", { type: "user", id: t.id, details: changes });
    }
    return json(200, userRead(t));
  }],
  ["GET", /^\/admin\/audit$/, (c) => {
    admin(c);
    const action = c.query.get("action");
    const rows = c.s.audit.filter((a) => !action || a.action === action).slice().reverse();
    const limit = Number(c.query.get("limit") ?? 50);
    return json(200, { items: rows.slice(0, limit), total: rows.length, limit, offset: 0 });
  }],
  ["GET", /^\/admin\/audit\/verify$/, async (c) => {
    admin(c);
    let prev = "0".repeat(64);
    for (const [i, a] of c.s.audit.entries()) {
      if (a.prev_hash !== prev) return json(200, { valid: false, records_checked: i + 1, first_invalid_id: a.id, reason: "prev_hash does not link" });
      if ((await sha256(prev + canonical(auditRecord(a)))) !== a.hash) return json(200, { valid: false, records_checked: i + 1, first_invalid_id: a.id, reason: "record hash mismatch" });
      prev = a.hash;
    }
    return json(200, { valid: true, records_checked: c.s.audit.length });
  }],

  ["GET", /^\/markets\/status$/, (c) => { authUser(c); return json(200, marketStatuses()); }],
  ["GET", /^\/markets\/overview$/, (c) => {
    authUser(c);
    const groups: Record<string, unknown[]> = { CRYPTO: [], FX: [], STOCK: [], ETF: [] };
    for (const i of [...INSTRUMENTS].sort((a, b) => a.symbol.localeCompare(b.symbol))) groups[i.asset_class]!.push(withQuote(i));
    return json(200, { markets: marketStatuses(), groups, data_mode: "synthetic" });
  }],
  ["GET", /^\/markets\/instruments$/, (c) => {
    authUser(c);
    const cls = c.query.get("asset_class"); const q = c.query.get("q")?.toLowerCase();
    return json(200, INSTRUMENTS.filter((i) => (!cls || i.asset_class === cls) && (!q || `${i.symbol} ${i.display_name}`.toLowerCase().includes(q))).map(instRead));
  }],
  ["GET", /^\/markets\/instruments\/([^/]+)$/, (c) => { authUser(c); return json(200, withQuote(findInst(c.params[0]!))); }],
  ["GET", /^\/markets\/instruments\/([^/]+)\/quote$/, (c) => { authUser(c); return json(200, mkt.quote(findInst(c.params[0]!))); }],
  ["GET", /^\/markets\/instruments\/([^/]+)\/candles$/, (c) => {
    authUser(c);
    const i = findInst(c.params[0]!);
    const tf = c.query.get("timeframe") ?? "1h";
    if (!mkt.TIMEFRAMES[tf]) throw new HttpError(422, "business_rule_violation", "Unsupported timeframe");
    const limit = Math.min(Number(c.query.get("limit") ?? 200), 1000);
    const rows = mkt.candles(i, tf, limit);
    const names = (c.query.get("indicators") ?? "").split(",").filter(Boolean);
    return json(200, { symbol: i.symbol, timeframe: tf, source: "synthetic", candles: rows, indicators: mkt.indicators(names, rows.map((r) => +r.close)) });
  }],
  ["GET", /^\/markets\/watchlist$/, (c) => json(200, watchlist(c.s, authUser(c).user.id))],
  ["POST", /^\/markets\/watchlist\/items$/, (c) => {
    const { user } = authUser(c);
    const i = findInst(String(c.body.symbol ?? ""));
    const wl = watchlist(c.s, user.id);
    if (wl.items.some((x) => x.instrument.symbol === i.symbol)) throw new HttpError(409, "conflict", `${i.symbol} is already on the watchlist`);
    c.s.watchlists[user.id]!.push(i.symbol);
    return json(201, watchlist(c.s, user.id));
  }],
  ["DELETE", /^\/markets\/watchlist\/items\/([^/]+)$/, (c) => {
    const { user } = authUser(c);
    const i = findInst(c.params[0]!);
    watchlist(c.s, user.id);
    const list = c.s.watchlists[user.id]!;
    if (!list.includes(i.symbol)) throw new HttpError(404, "not_found", `${i.symbol} is not on the watchlist`);
    c.s.watchlists[user.id] = list.filter((x) => x !== i.symbol);
    return json(200, watchlist(c.s, user.id));
  }],

  ["GET", /^\/research\/status$/, (c) => { authUser(c); return json(200, { engine: "extractive", model: null, embedding_model: "hashing-v1-384 (browser)", documents: c.s.docs.length, chunks: c.s.chunks.length, url_ingestion_enabled: false }); }],
  ["GET", /^\/research\/documents$/, (c) => {
    authUser(c);
    const q = c.query.get("q")?.toLowerCase(), type = c.query.get("doc_type"), sym = c.query.get("symbol");
    const rows = c.s.docs.filter((d) => (!q || d.title.toLowerCase().includes(q)) && (!type || d.doc_type === type) && (!sym || d.symbols.includes(sym)))
      .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
    return json(200, { items: rows.map(docRead), total: rows.length, limit: 200, offset: 0 });
  }],
  ["GET", /^\/research\/documents\/([\w-]+)$/, (c) => {
    authUser(c);
    const d = c.s.docs.find((x) => x.id === c.params[0]);
    if (!d) throw new HttpError(404, "not_found", "Research document not found");
    const chunks = c.s.chunks.filter((x) => x.document_id === d.id).sort((a, b) => a.ordinal - b.ordinal).map(({ embedding: _e, document_id: _d, ...rest }) => rest);
    return json(200, { ...docRead(d), chunks });
  }],
  ["POST", /^\/research\/documents$/, async (c) => {
    const { user } = admin(c);
    if (!c.body.text) throw new HttpError(422, "business_rule_violation", "Provide `text` (HTML ingestion of pasted markup requires the backend)");
    const r = await ingest(c.s, { title: String(c.body.title ?? ""), text: String(c.body.text), source_name: String(c.body.source_name ?? "Manual"), source_url: (c.body.source_url as string) ?? null, published_at: (c.body.published_at as string) ?? null, doc_type: (c.body.doc_type as string) ?? null, content_type: "text/plain" });
    return finishIngest(c.s, user, [r], "manual");
  }],
  ["POST", /^\/research\/documents\/upload$/, async (c) => {
    const { user } = admin(c);
    const file = c.form?.get("file");
    if (!(file instanceof File)) throw bad("file is required", "file");
    if (file.size > 10 * 1024 * 1024) throw new HttpError(422, "business_rule_violation", "Document exceeds the 10 MB limit");
    const name = file.name.toLowerCase();
    if (name.endsWith(".pdf") || file.type === "application/pdf") throw new HttpError(422, "business_rule_violation", "PDF extraction runs on the AUREX backend and is not available in the browser demo");
    const raw = await file.text();
    const html = name.endsWith(".html") || name.endsWith(".htm") || /^\s*<(!doctype|html)/i.test(raw);
    const { title, text } = html ? rs.htmlToText(raw) : { title: "", text: raw };
    const r = await ingest(c.s, { title: title || file.name, text, source_name: String(c.form?.get("source_name") ?? "Upload"), published_at: (c.form?.get("published_at") as string) || null, content_type: html ? "text/html" : "text/plain" });
    return finishIngest(c.s, user, [r], "upload");
  }],
  ["POST", /^\/research\/documents\/fetch$/, (c) => { admin(c); throw new HttpError(403, "forbidden", "URL ingestion requires the AUREX backend"); }],
  ["DELETE", /^\/research\/documents\/([\w-]+)$/, async (c) => {
    const { user } = admin(c);
    const d = c.s.docs.find((x) => x.id === c.params[0]);
    if (!d) throw new HttpError(404, "not_found", "Research document not found");
    c.s.docs = c.s.docs.filter((x) => x.id !== d.id);
    c.s.chunks = c.s.chunks.filter((x) => x.document_id !== d.id);
    await audit(c.s, user.id, "research.document.delete", { type: "research_document", id: d.id, details: { title: d.title } });
    return json(204, null);
  }],
  ["POST", /^\/research\/samples$/, async (c) => {
    const { user } = admin(c);
    const created = await loadSamples(c.s);
    if (created) await audit(c.s, user.id, "research.samples.load", { details: { documents: created } });
    const samples = c.s.docs.filter((d) => d.is_sample);
    return json(200, { created, duplicates: samples.length - created, documents: samples.map(docRead) });
  }],
  ["GET", /^\/research\/search$/, (c) => {
    authUser(c);
    const q = c.query.get("q") ?? "";
    const syms = (c.query.get("symbols") ?? "").split(",").filter(Boolean);
    const hits = rs.search(c.s.docs, c.s.chunks, q, Number(c.query.get("k") ?? 8), syms);
    return json(200, hits.map((h) => ({ chunk_id: h.chunk.id, document: docRead(h.doc), text: h.chunk.text, page: h.chunk.page, paragraph: h.chunk.paragraph, score: h.score, stale: false })));
  }],
  ["POST", /^\/research\/ask$/, async (c) => {
    const { user } = authUser(c);
    const question = String(c.body.question ?? "").trim();
    if (question.length < 3) throw bad("Question is too short", "question");
    const t0 = performance.now();
    const symbols = Array.isArray(c.body.symbols) ? (c.body.symbols as string[]) : [];
    const ev = rs.search(c.s.docs, c.s.chunks, question, 8, symbols, (c.body.max_age_days as number) || undefined);
    const body = rs.report(question, ev);
    const r = { id: uuid(), user_id: user.id, question, symbols, engine: body.engine, confidence: body.confidence.score, insufficient_evidence: body.insufficient_evidence, created_at: now(), latency_ms: Math.round(performance.now() - t0), body };
    c.s.reports.push(r);
    await audit(c.s, user.id, "research.ask", { type: "research_report", id: r.id, details: { engine: r.engine, sources: ev.length, facts: body.facts.length } });
    return json(201, r);
  }],
  ["GET", /^\/research\/reports$/, (c) => {
    const { user } = authUser(c);
    const mine = c.s.reports.filter((r) => r.user_id === user.id).reverse();
    return json(200, { items: mine.slice(0, 30).map(reportSummary), total: mine.length, limit: 30, offset: 0 });
  }],
  ["GET", /^\/ai\/agents$/, (c) => { authUser(c); return json(200, agentList(c.s)); }],
  ["PATCH", /^\/ai\/agents\/(\w+)$/, async (c) => {
    const { user } = admin(c);
    const meta = agentList(c.s).find((a) => a.name === c.params[0]);
    if (!meta) throw new HttpError(404, "not_found", "Agent not found");
    if (meta.kind === "gate" && (c.body.enabled === false || (c.body.weight != null && c.body.weight !== 0))) throw new HttpError(422, "business_rule_violation", "Gate agents (regime, portfolio, risk) cannot be disabled or weighted");
    const w = c.body.weight as number | undefined;
    if (w != null && (typeof w !== "number" || w < 0 || w > 1)) throw bad("weight must be between 0 and 1", "weight");
    c.s.aiAgents[meta.name] = { enabled: (c.body.enabled as boolean | undefined) ?? meta.enabled, weight: w ?? meta.weight };
    await audit(c.s, user.id, "ai.agent.update", { type: "ai_agent", id: meta.name, details: c.body });
    return json(200, agentList(c.s).find((a) => a.name === meta.name));
  }],
  ["POST", /^\/ai\/run$/, async (c) => {
    const { user } = authUser(c);
    const t0 = performance.now(), started = now();
    const inst = findInst(String(c.body.symbol ?? ""));
    const mine = c.s.accounts.filter((a) => a.owner_id === user.id && a.status === "ACTIVE");
    const acct = c.body.account_id ? mine.find((a) => a.id === c.body.account_id) : mine[0];
    if (c.body.account_id && !acct) throw new HttpError(404, "not_found", "Trading account not found");
    const bars = (tf: string, n: number) => mkt.candles(inst, tf, n).map((b) => ({ t: b.open_time, o: +b.open, h: +b.high, l: +b.low, c: +b.close }));
    const q = mkt.quote(inst);
    const nowMs = Date.now();
    const sig = (d: rs.DDoc) => ({ title: d.title, doc_type: d.doc_type, age_days: d.published_at ? (nowMs - Date.parse(d.published_at)) / 86_400_000 : 9999, sentiment: d.sentiment, is_sample: d.is_sample });
    const docs = c.s.docs.filter((d) => d.symbols.includes(inst.symbol) && d.published_at).map(sig).filter((d) => d.age_days <= 400);
    const macro = inst.asset_class === "FX" || inst.asset_class === "ETF"
      ? c.s.docs.filter((d) => (d.doc_type === "central_bank" || d.doc_type === "economic_data") && d.published_at).map(sig).filter((d) => d.age_days <= 30) : [];
    const bal = acct ? balances(c.s, acct) : null;
    const ctx: ag.Ctx = {
      symbol: inst.symbol, asset_class: inst.asset_class, quote_currency: inst.quote_currency, price_decimals: inst.price_decimals,
      lot_size: Number(inst.lot_size), now: nowMs, h1: bars("1h", 300), d1: bars("1d", 250),
      quote: { last: +q.last, bid: +q.bid, ask: +q.ask, market_open: q.market_open, stale: q.stale, tradable: q.tradable, source: q.source },
      docs, macro, account: acct && bal ? { id: acct.id, currency: acct.base_currency, equity: +bal.equity, cash: +bal.cash } : null,
      fx: acct ? fxRate(inst.quote_currency, acct.base_currency) : null, open_positions: 0,
    };
    const agents = agentList(c.s);
    const enabled = new Set(agents.filter((a) => a.enabled).map((a) => a.name));
    const weights = Object.fromEntries(agents.filter((a) => a.kind === "directional" && a.enabled).map((a) => [a.name, a.weight]));
    if (!Object.keys(weights).length) throw new HttpError(422, "business_rule_violation", "All directional agents are disabled");
    const findings = ag.runAgents(ctx, enabled);
    const d = ag.decide(ctx, findings, weights);
    const id = uuid();
    const run = {
      id, user_id: user.id, account_id: acct?.id ?? null, symbol: inst.symbol, ...d, proposal: null as Record<string, unknown> | null,
      context: { as_of: new Date(nowMs).toISOString(), quote: ctx.quote, bars_1h: ctx.h1.length, bars_1d: ctx.d1.length, research_docs: docs.length, macro_docs: macro.length, account: ctx.account, fx_to_account: ctx.fx, open_positions: 0 },
      findings: ag.ORDER.map((n) => { const { data: _d, ...rest } = findings[n]!; return rest; }),
      started_at: started, finished_at: now(), created_at: now(), latency_ms: Math.round(performance.now() - t0),
    };
    if (d.proposal && acct) run.proposal = { ...d.proposal, id: uuid(), run_id: id, account_id: acct.id, account_currency: acct.base_currency, status: "PENDING_RISK_REVIEW", created_at: now(), dismissed_at: null };
    c.s.aiRuns.push(run);
    await audit(c.s, user.id, "ai.run", { type: "ai_run", id, details: { symbol: run.symbol, decision: run.decision, net_score: run.net_score, proposal: run.proposal?.id ?? null } });
    const { user_id: _u, ...out } = run;
    return json(201, { ...out, proposal: withEffective(run.proposal) });
  }],
  ["GET", /^\/ai\/runs$/, (c) => {
    const { user } = authUser(c);
    const mine = c.s.aiRuns.filter((r) => r.user_id === user.id).reverse();
    return json(200, { items: mine.slice(0, 30).map(runSummary), total: mine.length, limit: 30, offset: 0 });
  }],
  ["GET", /^\/ai\/runs\/([\w-]+)$/, (c) => {
    const { user } = authUser(c);
    const r = c.s.aiRuns.find((x) => x.id === c.params[0] && x.user_id === user.id);
    if (!r) throw new HttpError(404, "not_found", "Run not found");
    const { user_id: _u, ...out } = r;
    return json(200, { ...out, proposal: withEffective(r.proposal) });
  }],
  ["GET", /^\/ai\/proposals$/, (c) => {
    const { user } = authUser(c);
    const ps = c.s.aiRuns.filter((r) => r.user_id === user.id && r.proposal).map((r) => withEffective(r.proposal)).reverse();
    return json(200, { items: ps.slice(0, 30), total: ps.length, limit: 30, offset: 0 });
  }],
  ["POST", /^\/ai\/proposals\/([\w-]+)\/dismiss$/, async (c) => {
    const { user } = authUser(c);
    const r = c.s.aiRuns.find((x) => x.user_id === user.id && x.proposal?.id === c.params[0]);
    if (!r) throw new HttpError(404, "not_found", "Proposal not found");
    if (r.proposal.status !== "PENDING_RISK_REVIEW") throw new HttpError(422, "business_rule_violation", "Only pending proposals can be dismissed");
    r.proposal.status = "DISMISSED"; r.proposal.dismissed_at = now();
    await audit(c.s, user.id, "ai.proposal.dismiss", { type: "trade_proposal", id: r.proposal.id });
    return json(200, withEffective(r.proposal));
  }],
  ["GET", /^\/research\/reports\/([\w-]+)$/, (c) => {
    const { user } = authUser(c);
    const r = c.s.reports.find((x) => x.id === c.params[0] && x.user_id === user.id);
    if (!r) throw new HttpError(404, "not_found", "Report not found");
    return json(200, r);
  }],
];

/** fetch()-compatible entry point used by services/api.ts in demo builds. */
export async function demoFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, "https://demo.local");
  const path = url.pathname.replace(/^.*\/api\/v1/, "");
  const method = (init.method ?? "GET").toUpperCase();
  const s = load();
  try {
    for (const [m, re, handler] of routes) {
      if (m !== method) continue;
      const match = path.match(re);
      if (!match) continue;
      const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : {};
      const form = init.body instanceof FormData ? init.body : undefined;
      const res = await handler({ s, body, form, headers: new Headers(init.headers), params: match.slice(1), query: url.searchParams });
      if (method !== "GET" || path.startsWith("/markets/watchlist") || path.startsWith("/users/me/settings")) save();
      return res;
    }
    throw new HttpError(404, "not_found", `No demo route for ${method} ${path}`);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: { code: e.code, message: e.message, details: e.details ?? null, request_id: null } });
    throw e;
  }
}

export function resetDemo() {
  memory = null;
  try { localStorage.removeItem(KEY); localStorage.removeItem(REFRESH_KEY); } catch { /* ignore */ }
}
