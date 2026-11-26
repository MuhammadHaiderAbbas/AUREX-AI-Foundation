# Market data (Phase 3)

```
                       ┌──────────── MarketService ────────────┐
REST /markets/* ──────►│ registry · quotes (1s cache) · candles │──► market_candles (PostgreSQL)
WS   /markets/stream ─►│ staleness · tradability · gap-fill     │
                       └───────────────┬────────────────────────┘
                                       │ MarketDataProvider (one interface)
                 ┌─────────────────────┼──────────────────────┐
   SyntheticProvider   CoinbaseProvider       LiveFxProvider          AlpacaProvider
   (default, offline)  crypto: WS ticker      FX: Coinbase rates +    US stocks/ETFs
                       quotes, REST candles,  ECB daily (Frankfurter) (free key, IEX)
                       30s bars recorded      simulated intraday
```

## Instruments
`assets` (economic asset) → `instruments` (a listing on a venue, in a quote currency).
`instrument_type` is constrained to cash instruments — `SPOT`, `SPOT_FX`, `SHARE`, `ETF` —
so CFDs and derivatives cannot be confused with them when added later. Seeded: 12 crypto pairs
(BTC, ETH, SOL, XRP, DOGE, ADA, AVAX, LINK, LTC, DOT, BCH, PAXG); EUR/USD, GBP/USD, USD/JPY;
AAPL, MSFT, NVDA, TSLA, NFLX, SHEL.L, AZN.L; SPY, QQQ, DIA, GLD, USO, ISF.L.
URLs use the `slug` (symbol without `/`), e.g. `/markets/instruments/EURUSD/candles`.

## Sessions
`app/market/calendar.py`: crypto 24/7; FX Sun 17:00 → Fri 17:00 New York; NYSE/Nasdaq
09:30–16:00 ET; LSE 08:00–16:30 London — all DST-aware, with 2026–27 full-day holidays.
Early closes are not yet modelled.

## Data modes (`AUREX_MARKET_DATA_MODE`)
| Mode | Crypto | FX | Stocks / ETFs |
|---|---|---|---|
| `synthetic` (default) | synthetic | synthetic | synthetic |
| `live` | Coinbase Exchange (quotes from the WebSocket feed, REST fallback; 30s bars recorded by the worker leader) | Coinbase exchange rates (tradable, ~1/min upstream), ECB daily history, simulated intraday candles scaled to the live rate (`source: synthetic`) | Alpaca IEX with a key, otherwise synthetic; UK listings synthetic |

Set `AUREX_FX_LIVE_RATES=false` to fall back to ECB reference rates only (never tradable).

Every quote and candle carries its `source`, and the UI labels synthetic data. If a provider
fails, the API returns `503 market_data_unavailable`. It never substitutes synthetic prices
for the real ones it was asked for.

## Quotes: stale and tradable
`stale = market open AND age > threshold` (60s crypto/FX, 120s equities).
`tradable = market open AND not stale AND source is not a reference rate`.
The Phase 9 risk gate will reject orders on non-tradable quotes.

## Candles
A read-through store keyed by `(instrument, timeframe, open_time)`. Each request fills the gap
since the last stored candle (or the requested look-back), upserts it, and serves from
PostgreSQL. Only completed candles are stored, and a DB check enforces OHLC consistency.
Admins can backfill with `POST /markets/backfill` (audited). 4h crypto candles are aggregated
from 1h, because Coinbase does not offer 4h.

## Synthetic generator
A pure function of `(symbol, timestamp)`: deterministic, consistent across timeframes, with
realised volatility calibrated to per-class targets. It respects sessions, so there are no
weekend equity candles. It is mirrored bit-for-bit in TypeScript for the static demo, and
pinned hash values are asserted in both codebases.

## Streaming
`WS /api/v1/markets/stream`. The first frame is `{"type":"auth","token":…}` (in-band, so
tokens never reach URL logs), then `{"type":"subscribe","symbols":[…]}` (max 50). The server
pushes `quotes` frames every `AUREX_STREAM_INTERVAL_SECONDS`. The SPA falls back to polling
if the socket fails. Single-node fan-out for now; Redis Streams when the API scales out.
