/**
 * API client.
 * - Access token lives in memory only (never localStorage).
 * - Refresh token is an httpOnly cookie scoped to /api/v1/auth.
 * - Refresh calls are de-duplicated: the server rotates refresh tokens and treats a
 *   replayed token as theft, so two parallel refreshes would log the user out.
 */
export const API_BASE = "/api/v1";

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
    refreshInFlight = fetch(`${API_BASE}/auth/refresh`, { method: "POST", credentials: "same-origin" })
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
  const res = await fetch(`${API_BASE}${path}`, {
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
