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
}

let memory: State | null = null;
function load(): State {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return (memory = JSON.parse(raw) as State);
  } catch { /* storage unavailable: fall back to memory */ }
  return (memory = { users: [], sessions: [], accounts: [], txns: [], audit: [], settings: {}, watchlists: {} });
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
type Ctx = { s: State; body: Record<string, unknown>; headers: Headers; params: string[]; query: URLSearchParams };
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
      const res = await handler({ s, body, headers: new Headers(init.headers), params: match.slice(1), query: url.searchParams });
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
