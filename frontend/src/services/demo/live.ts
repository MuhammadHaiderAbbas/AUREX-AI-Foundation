/**
 * Real, keyless market data for the static demo: Coinbase Exchange public endpoints.
 *   - WebSocket ticker (wss://ws-feed.exchange.coinbase.com): every trade's price, best bid/ask
 *   - REST candles (api.exchange.coinbase.com/products/{id}/candles), CORS-enabled
 * Crypto instruments use these when reachable; everything else (FX, stocks, ETFs) stays on the
 * synthetic generator because real-time feeds for them need a paid, keyed vendor.
 * Ticks are kept per symbol (last 2 hours) so charts can be rebuilt without gaps after the tab
 * was hidden or the page was changed; WebSocket messages keep arriving in background tabs.
 */

export const LIVE_PRODUCTS: Record<string, string> = Object.fromEntries(
  ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK", "LTC", "DOT", "BCH", "PAXG"].map((c) => [`${c}-USD`, `${c}-USD`]));
const REST = "https://api.exchange.coinbase.com";
const WS = "wss://ws-feed.exchange.coinbase.com";
const GRANULARITY: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 };
const TICK_WINDOW_MS = 2 * 3600 * 1000;
const STALE_MS = 30_000;

export interface LiveTick { t: number; price: number; bid: number; ask: number; open24h: number | null }
export interface LiveCandle { open_time: string; open: number; high: number; low: number; close: number; volume: number }

const ticks: Record<string, LiveTick[]> = {};
const candleCache = new Map<string, { at: number; rows: LiveCandle[]; requested: number }>();
const listeners = new Set<(symbol: string) => void>();
let ws: WebSocket | null = null;
let status: "off" | "connecting" | "live" | "unavailable" = "off";
let started: Promise<void> | null = null;
let retry = 0;

/** Forex from Coinbase's public exchange-rates API (refreshes about once a minute) and ECB daily history (Frankfurter). */
export const FX_PAIRS: Record<string, { ccy: string; invert: boolean }> = {
  "EUR/USD": { ccy: "EUR", invert: true }, "GBP/USD": { ccy: "GBP", invert: true }, "USD/JPY": { ccy: "JPY", invert: false },
};
const RATES = "https://api.coinbase.com/v2/exchange-rates?currency=USD";
const FRANKFURTER = "https://api.frankfurter.dev/v1";
const FX_SPREAD = 0.00002;
const fxPrev: Record<string, number> = {};
const fxDaily: Record<string, LiveCandle[]> = {};
let fxTimer: ReturnType<typeof setInterval> | null = null;

async function pollFx() {
  try {
    const r = await fetch(RATES).then((x) => x.json()) as { data: { rates: Record<string, string> } };
    const now = Date.now();
    for (const [sym, { ccy, invert }] of Object.entries(FX_PAIRS)) {
      const raw = Number(r.data.rates[ccy]);
      if (!raw) continue;
      const price = invert ? 1 / raw : raw;
      push(sym, { t: now, price, bid: price * (1 - FX_SPREAD), ask: price * (1 + FX_SPREAD), open24h: fxPrev[sym] ?? null });
    }
  } catch { /* keep the last rate; quotes fall back to simulated after it goes stale */ }
}

async function loadFxDaily() {
  try {
    const end = new Date(), start = new Date(end.getTime() - 400 * 864e5);
    const r = await fetch(`${FRANKFURTER}/${start.toISOString().slice(0, 10)}..?base=USD&symbols=EUR,GBP,JPY`).then((x) => x.json()) as { rates: Record<string, Record<string, number>> };
    const days = Object.keys(r.rates).sort();
    for (const [sym, { ccy, invert }] of Object.entries(FX_PAIRS)) {
      let prev: number | null = null;
      fxDaily[sym] = days.map((d) => {
        const v = invert ? 1 / r.rates[d]![ccy]! : r.rates[d]![ccy]!;
        const o = prev ?? v; prev = v;
        return { open_time: `${d}T00:00:00.000Z`, open: o, high: Math.max(o, v), low: Math.min(o, v), close: v, volume: 0 };
      });
      const last = fxDaily[sym]!.at(-1);
      if (last) fxPrev[sym] = last.close;
    }
  } catch { /* daily history unavailable: forex 1d candles stay simulated */ }
}

export const isLiveFx = (s: string) => s in FX_PAIRS;
export const fxDailyCandles = (s: string, limit: number) => (fxDaily[s]?.length ? fxDaily[s]!.slice(-limit) : null);
export const isLiveSymbol = (s: string) => s in LIVE_PRODUCTS;
export const liveStatus = () => status;
export function onTick(cb: (symbol: string) => void) { listeners.add(cb); return () => listeners.delete(cb); }

function push(symbol: string, tick: LiveTick) {
  const arr = (ticks[symbol] ??= []);
  const last = arr[arr.length - 1];
  if (last && tick.t < last.t) return;
  arr.push(tick);
  const cut = tick.t - TICK_WINDOW_MS;
  let i = 0;
  while (i < arr.length && arr[i]!.t < cut) i++;
  if (i) arr.splice(0, i);
  for (const l of listeners) l(symbol);
}

// Coinbase public REST allows a few requests per second per IP: queue them (at most 3 at a time,
// 120 ms apart) and back off on HTTP 429 instead of firing a burst on page load.
let inFlight = 0, lastStart = 0;
const waiting: (() => void)[] = [];
async function slot() {
  if (inFlight >= 3) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  const wait = Math.max(0, lastStart + 120 - Date.now());
  lastStart = Date.now() + wait;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}
const release = () => { inFlight--; waiting.shift()?.(); };

async function getJson<T>(path: string, timeoutMs = 8000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await slot();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(REST + path, { signal: ctl.signal, headers: { Accept: "application/json" } });
      if (r.status === 429 && attempt < 3) { await new Promise((res) => setTimeout(res, 600 * 2 ** attempt)); continue; }
      if (!r.ok) throw new Error(`coinbase ${r.status}`);
      return (await r.json()) as T;
    } finally { clearTimeout(timer); release(); }
  }
}

function connect() {
  if (typeof WebSocket === "undefined") return;
  ws = new WebSocket(WS);
  ws.onopen = () => {
    retry = 0;
    ws!.send(JSON.stringify({ type: "subscribe", product_ids: Object.values(LIVE_PRODUCTS), channels: ["ticker"] }));
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data as string);
    if (m.type !== "ticker" || !m.price) return;
    const symbol = Object.keys(LIVE_PRODUCTS).find((k) => LIVE_PRODUCTS[k] === m.product_id);
    if (!symbol) return;
    status = "live";
    push(symbol, { t: m.time ? Date.parse(m.time) : Date.now(), price: +m.price, bid: +(m.best_bid ?? m.price), ask: +(m.best_ask ?? m.price),
      open24h: m.open_24h ? +m.open_24h : null });
  };
  ws.onclose = () => { ws = null; setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++)); };
  ws.onerror = () => ws?.close();
}

/** Start once: seed each product with a REST ticker (so the first page has real prices), then stream. */
export function start(): Promise<void> {
  if (started) return started;
  status = "connecting";
  started = (async () => {
    const results = await Promise.allSettled(Object.entries(LIVE_PRODUCTS).map(async ([symbol, id]) => {
      const t = await getJson<{ price: string; bid: string; ask: string; time: string }>(`/products/${id}/ticker`);
      push(symbol, { t: Date.parse(t.time) || Date.now(), price: +t.price, bid: +t.bid, ask: +t.ask, open24h: null });
    }));
    void loadFxDaily().then(pollFx);              // forex loads in the background; quotes fall back until it arrives
    fxTimer ??= setInterval(pollFx, 30_000);
    if (results.every((r) => r.status === "rejected")) { status = "unavailable"; return; }
    status = "live";
    connect();
  })();
  return started;
}

/** Latest real tick, or null when unavailable/stale (callers fall back to synthetic prices). */
export function latest(symbol: string): LiveTick | null {
  const arr = ticks[symbol];
  const t = arr?.[arr.length - 1];
  return t && Date.now() - t.t < (symbol in FX_PAIRS ? 180_000 : STALE_MS) ? t : null;
}

/** First real tick at or after `ms` (binary settlement), if any arrived within 2 minutes of it. */
export function priceAtOrAfter(symbol: string, ms: number): LiveTick | null {
  for (const t of ticks[symbol] ?? []) if (t.t >= ms) return t.t - ms < 120_000 ? t : null;
  return null;
}

export const tickHistory = (symbol: string, sinceMs: number) => (ticks[symbol] ?? []).filter((t) => t.t >= sinceMs);

/** Fetch real candles into the cache (refreshed after a fraction of the timeframe). Returns false when unavailable. */
export async function ensureCandles(symbol: string, timeframe: string, limit: number): Promise<boolean> {
  const id = LIVE_PRODUCTS[symbol];
  if (!id) return false;
  await start();
  if (status === "unavailable") return false;
  const tf = timeframe === "4h" ? "1h" : timeframe;
  const g = GRANULARITY[tf];
  if (!g) return false;
  const want = Math.min(timeframe === "4h" ? limit * 4 : limit, 4400);
  const key = `${symbol}|${tf}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < Math.min(60_000, g * 500) && hit.requested >= want) return true;
  try {
    const out: LiveCandle[] = [];
    let end = Math.floor(Date.now() / 1000);
    for (let page = 0; page < Math.ceil(want / 300); page++) {
      const begin = end - g * 300;
      const raw = await getJson<number[][]>(`/products/${id}/candles?granularity=${g}&start=${new Date(begin * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`);
      if (!raw.length) break;
      for (const [t, low, high, open, close, volume] of raw) out.push({ open_time: new Date(t! * 1000).toISOString(), open: open!, high: high!, low: low!, close: close!, volume: volume! });
      end = begin;
    }
    if (!out.length) return false;
    const rows = out.sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time))
      .filter((r, k, arr) => k === 0 || r.open_time !== arr[k - 1]!.open_time);
    candleCache.set(key, { at: Date.now(), rows, requested: want });
    return true;
  } catch { return !!hit; }
}

/** Cached real candles extended with ticks that arrived since (sync); null when not cached. */
export function candlesSync(symbol: string, timeframe: string, limit: number): LiveCandle[] | null {
  const tf = timeframe === "4h" ? "1h" : timeframe;
  const g = GRANULARITY[tf];
  const hit = g ? candleCache.get(`${symbol}|${tf}`) : undefined;
  if (!hit || !hit.rows.length) return null;
  const rows = hit.rows.map((r) => ({ ...r }));
  for (const t of ticks[symbol] ?? []) {
    const bucket = Math.floor(t.t / 1000 / g!) * g! * 1000;
    const cur = rows[rows.length - 1]!;
    const curStart = Date.parse(cur.open_time);
    if (bucket < curStart) continue;
    if (bucket === curStart) { cur.close = t.price; cur.high = Math.max(cur.high, t.price); cur.low = Math.min(cur.low, t.price); }
    else rows.push({ open_time: new Date(bucket).toISOString(), open: cur.close, high: Math.max(cur.close, t.price), low: Math.min(cur.close, t.price), close: t.price, volume: 0 });
  }
  let out = rows;
  if (timeframe === "4h") {
    out = [];
    for (const r of rows) {
      const b = Math.floor(Date.parse(r.open_time) / 14_400_000) * 14_400_000;
      const a = out[out.length - 1];
      if (a && Date.parse(a.open_time) === b) { a.high = Math.max(a.high, r.high); a.low = Math.min(a.low, r.low); a.close = r.close; a.volume += r.volume; }
      else out.push({ ...r, open_time: new Date(b).toISOString() });
    }
  }
  return out.slice(-limit);
}
