import asyncio
import time
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.backtest import strategies as strat
from app.backtest.engine import DEFAULT_COSTS, Bars, Costs, Risk
from app.backtest.evaluate import evaluate
from app.core.errors import BusinessRuleViolation
from app.market.service import MarketService, provider_for
from app.models import Backtest, MarketCandle, StrategyDef, User


class BacktestService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.market = MarketService(db)

    async def bars(self, symbol: str, days: int):
        inst = await self.market.get(symbol)
        await self.market.backfill(inst, "1h", days)
        since = datetime.now(UTC) - timedelta(days=days)
        rows = list(await self.db.scalars(select(MarketCandle).where(
            MarketCandle.instrument_id == inst.id, MarketCandle.timeframe == "1h",
            MarketCandle.open_time >= since).order_by(MarketCandle.open_time)))
        b = Bars([r.open_time for r in rows], *(np.array([float(getattr(r, k)) for r in rows])
                                                 for k in ("open", "high", "low", "close")))
        return inst, b

    async def run(self, user: User, *, strategy: str, symbol: str, days: int, params: dict[str, Any] | None,
                  optimise: bool, capital: float, cost_overrides: dict[str, float]) -> Backtest:
        sdef = await self.db.get(StrategyDef, strategy)
        if sdef is None or not sdef.enabled or strategy not in strat.STRATEGIES:
            raise BusinessRuleViolation(f"Unknown or disabled strategy. Available: {', '.join(strat.STRATEGIES)}")
        try:
            strat.build(strategy, params)
        except ValueError as e:
            raise BusinessRuleViolation(str(e)) from e
        inst, bars = await self.bars(symbol, days)
        if len(bars) < 300:
            raise BusinessRuleViolation("Not enough history for a backtest (need at least 300 hourly bars)")
        costs = Costs(**{**asdict(DEFAULT_COSTS[inst.asset_class]), **cost_overrides})
        risk = Risk()
        t0 = time.perf_counter()
        try:
            result = await asyncio.to_thread(
                evaluate, bars, strategy, params, asset_class=inst.asset_class, costs=costs, risk=risk,
                capital=capital, optimise=optimise, lot_size=float(inst.lot_size))
        except ValueError as e:
            raise BusinessRuleViolation(str(e)) from e
        source = provider_for(inst).name
        if source == "synthetic":
            result["warnings"].insert(0, "Backtested on synthetic data: the generator is built from smooth cycles, so "
                                         "results describe the simulator, not a real market.")
        bt = Backtest(
            user_id=user.id, strategy_key=strategy, symbol=inst.symbol, timeframe="1h", days=days,
            params=result["params"], config={"costs": asdict(costs), "risk": asdict(risk), "capital": capital,
                                              "optimise": optimise, "asset_class": inst.asset_class},
            data_source=source, period_from=bars.t[0], period_to=bars.t[-1],
            oos_sharpe=result["out_of_sample"]["strategy"]["sharpe"],
            oos_return=result["out_of_sample"]["strategy"]["total_return"], result=result,
            latency_ms=int((time.perf_counter() - t0) * 1000))
        self.db.add(bt)
        await self.db.flush()
        return bt
