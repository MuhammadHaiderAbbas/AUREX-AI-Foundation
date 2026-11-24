# Analytics and reporting (Phase 10)

`backend/app/analytics/` is read-only. It derives every number from records that are
append-only or never change after a fill: the ledger, executions, portfolio snapshots, risk
decisions and events, and agent runs. A report can therefore be regenerated and compared
at any time.

## Performance

- **Equity series:** the opening funding, then every portfolio snapshot (taken on each fill,
  hourly while you use the platform, and hourly by the background monitor for accounts with
  open positions), then a live valuation now. The series is resampled to the last value of
  each UTC day, and days without a valuation carry the last known equity forward.
- **Time-weighted returns:** `r_t = (E_t − F_t) / E_{t−1} − 1`, where `F_t` is that day's
  net virtual deposits minus withdrawals. Moving virtual cash in or out is never counted as
  performance.
- **Metrics:**
  - total return, CAGR and annualised volatility, using 365-day annualisation;
  - Sharpe and Sortino, with a 0% risk-free rate;
  - maximum drawdown and the longest time spent under water;
  - Calmar ratio;
  - best and worst day, and the share of positive days.
- Ratios need at least **20 daily returns**. Below that they are reported as `null` with a
  note, not as a misleadingly precise number.
- **Benchmark:** buy & hold of SPY, QQQ, BTC-USD or ISF.L over the same window, from daily
  candles.

## Trades

A *round trip* is a closed position. Its net P&L is realised P&L minus all fees, so the sum
over trades reconciles exactly with the ledger's `REALISED_PNL − FEES` (tested).

- **Attribution:**
  - *opened by* is the source of the entry order: `manual`, `ai` or `autopilot`;
  - *exit* is how the position closed: `manual`, `stop` (protective stop), `target` (take
    profit) or `emergency`.
- **Statistics:**
  - win rate, profit factor, payoff ratio and expectancy;
  - best and worst trade;
  - average holding time;
  - return on capital deployed.
- Stats are broken down by source, exit, symbol and asset class.

## Execution quality

- Fees, spread cost (mid → bid/ask paid) and slippage (beyond the bid/ask), in money and in
  basis points of traded notional, overall and by asset class.
- Order outcomes by source, and the fill rate.
- Rejections grouped by reason. Risk rejections are labelled with the first check that
  failed, from the decision log.

## Risk

- Gate decisions by source.
- The checks that refused orders.
- A timeline of breaker trips, abnormal-activity halts and emergency stops.

## AI quality

- **Signal evaluation:** for every agent run older than the chosen horizon (4h to 7d), the
  price that many hours later is compared with the price the agents saw. The report gives
  hit rate and average forward return for BUY versus NO TRADE decisions, and their
  difference as the signal *edge*. Runs younger than the horizon are counted as pending.
- **Calibration:** confidence is bucketed against observed outcomes, with Brier score and
  expected calibration error. This is done both for BUY signals (did the price rise?) and
  for executed proposals (was the closed trade profitable?). Agent confidence is a heuristic
  score, and the report says so: these tables measure how far it is from a probability.
- **Model drift:** champion models with their eligibility and their latest drift check
  (maximum PSI), from the Phase 6 registry.

## Reports and exports

- `GET /analytics/accounts/{id}/report` assembles every section for the period, plus a
  ledger integrity check. It adds a **SHA-256 over the canonical JSON** of the content, so a
  saved copy can be verified later. Generating a report is audited, and the audit entry
  records the hash.
- `?download=true` returns the report as a JSON file. The UI also renders a print-friendly
  view for saving as PDF.
- CSV exports cover round trips, executions, orders, ledger entries, risk decisions and
  equity snapshots. Every export is audited. Text cells that start with `= + - @` (and are
  not numbers) are prefixed with `'` to defuse spreadsheet formula injection.
