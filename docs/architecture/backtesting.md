# Backtesting (Phase 7)

## Event order per bar (no look-ahead by construction)
| Step | What happens |
|---|---|
| 1 Fill | Orders submitted *latency* bars earlier fill at this bar's **open**, plus spread and slippage, plus fee |
| 2 Manage | Stop and target are checked against the bar's range. A **gap through the stop fills at the open**. If both are touched in one bar, the **stop is assumed** |
| 3 Mark | Equity is valued at the close, at the bid (liquidation value) |
| 4 Risk | **2% daily loss limit:** no new entries for the rest of the UTC day. **10% max drawdown:** the position is flattened and the strategy halted |
| 5 Signal | The strategy sees data up to this bar's close and may submit orders for later bars |

Market closures need no special code: session markets have no bars while closed, so a
Friday-close signal fills at Monday's open, gap included.

## Cost model (defaults per asset class, overridable per run)
| Asset class | Fee (bps per side) | Half spread (bps) | Base slippage (bps) | Volatility slippage | Latency |
|---|---|---|---|---|---|
| Crypto | 10 | 1.0 | 2 | 0.1 × recent bar σ | 1 bar |
| FX | 0 | 0.3 | 0.5 | 0.1 × σ | 1 bar |
| Shares | 1 | 1.0 | 2 | 0.1 × σ | 1 bar |
| ETFs | 1 | 0.5 | 1 | 0.1 × σ | 1 bar |

## Sizing and risk (blueprint defaults)
- 0.5% of equity at risk per trade, with the stop at 2 × ATR and the target at 3 × ATR.
- Each position is at most 20% of equity, and no leverage: a size that would need more
  cash than is available is capped at the cash balance.
- Long-only spot trading.

## Strategies
| Key | Rule | Optimisation grid |
|---|---|---|
| `sma_crossover` | Fast SMA crosses above slow; exit on cross back | fast {10, 20, 30} × slow {50, 100} |
| `rsi_reversion` | RSI drops through the entry level; exit above the exit level | entry {25, 30, 35} × exit {50, 60} |
| `donchian_breakout` | Close above the prior N-bar high; exit below the prior N/2-bar low | N {24, 48, 96, 168} |
| `agent_consensus` | Phase 5 technical + quant agents replayed every 4 bars on a rolling 200-bar window | min_net {0.2, 0.3} |

The agent replay excludes the research-driven agents, because the corpus is not
point-in-time. Every strategy computes causal signals, and a test perturbs future bars to
prove past signals don't change.

## Out-of-sample protocol
1. The period is split by time: the first 60% is in-sample (IS), the last 40% out-of-sample
   (OOS).
2. With optimisation on, every grid combination runs on IS only, and the best IS Sharpe
   (with ≥ 3 trades) is chosen.
3. The chosen parameters run **once** on OOS. A test spies on the engine to prove the grid
   never touches OOS data.
4. Reported: IS and OOS metrics against a **fully invested buy & hold benchmark** (no stops
   or breakers), the degradation between them, the sensitivity grid, the equity and
   drawdown curves, trades (fill prices, fees, exit reasons) and risk events.
5. Warnings: overfitting (OOS Sharpe below half of IS), underperforming buy & hold, fewer than
   10 OOS trades, the circuit breaker firing, and synthetic data.

## Metrics
Total return, CAGR, annualised volatility, Sharpe, Sortino, max drawdown, Calmar, trades,
win rate, profit factor, average win and loss, holding period, exposure, turnover, fees,
and spread & slippage cost.
