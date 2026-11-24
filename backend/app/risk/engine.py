"""Pure pre-trade risk rules. No I/O: the service gathers the inputs, this decides.

Every order, manual or AI, passes through `evaluate`. Orders that only reduce an existing
long position are always allowed through halts and sizing limits (so positions can be
exited), but still face the order-rate and price-collar checks.
"""

from dataclasses import asdict, dataclass
from decimal import Decimal

# Assumed stop distance (% of entry) when an entry order has no protective stop. It is used
# only to estimate the order's risk for the per-trade limit.
DEFAULT_STOP_PCT = {"CRYPTO": Decimal(5), "FX": Decimal(1), "STOCK": Decimal(3), "ETF": Decimal(2)}

# Hard ceilings: limits can be tightened freely and loosened only up to these values
# (the database enforces the same ranges).
CEILINGS = {
    "risk_per_trade_pct": 2.0, "max_position_pct": 50.0, "max_gross_exposure_pct": 100.0,
    "max_open_positions": 10, "daily_loss_limit_pct": 5.0, "max_drawdown_pct": 25.0,
    "max_orders_per_minute": 60, "price_collar_pct": 20.0,
}
DEFAULTS = {
    "risk_per_trade_pct": 0.5, "max_position_pct": 20.0, "max_gross_exposure_pct": 50.0,
    "max_open_positions": 5, "daily_loss_limit_pct": 2.0, "max_drawdown_pct": 10.0,
    "max_orders_per_minute": 20, "price_collar_pct": 5.0,
}


@dataclass(frozen=True)
class Limits:
    risk_per_trade_pct: float
    max_position_pct: float
    max_gross_exposure_pct: float
    max_open_positions: int
    daily_loss_limit_pct: float
    max_drawdown_pct: float
    max_orders_per_minute: int
    price_collar_pct: float


@dataclass(frozen=True)
class PreTrade:
    side: str
    reduces: bool                    # SELL against a held position
    system_halt: str | None          # reason, if the platform is halted
    kill_switch: str | None          # reason, if the account kill switch is engaged
    daily_halted: bool
    drawdown_halted: bool
    equity: Decimal                  # account currency
    notional: Decimal                # estimated, account currency
    risk_amount: Decimal             # estimated loss to the stop, account currency
    position_after: Decimal          # value of this instrument's position after the fill
    exposure_after: Decimal          # gross market value incl. open buys, after the fill
    open_positions_after: int
    collar_through_pct: float | None  # how far a limit price is through the market (positive = through)
    orders_last_minute: int


@dataclass
class Check:
    name: str
    label: str
    passed: bool
    value: str
    limit: str
    message: str = ""

    def dict(self) -> dict:
        return asdict(self)


def _pct(part: Decimal, whole: Decimal) -> float:
    return float(part / whole * 100) if whole > 0 else float("inf")


def evaluate(p: PreTrade, lim: Limits) -> list[Check]:
    checks: list[Check] = []

    def add(name: str, label: str, ok: bool, value: str, limit: str, message: str) -> None:
        checks.append(Check(name, label, ok, value, limit, "" if ok else message))

    exempt = p.reduces
    note = "risk-reducing order"
    # 1. halts and breakers
    add("system_halt", "Platform trading halt", exempt or p.system_halt is None,
        note if exempt and p.system_halt else ("halted" if p.system_halt else "trading"), "trading",
        f"platform trading is halted: {p.system_halt}")
    add("kill_switch", "Account kill switch", exempt or p.kill_switch is None,
        note if exempt and p.kill_switch else ("engaged" if p.kill_switch else "off"), "off",
        f"account kill switch is engaged: {p.kill_switch}")
    add("daily_loss", "Daily loss breaker", exempt or not p.daily_halted,
        "tripped" if p.daily_halted else "ok", f"{lim.daily_loss_limit_pct:g}% of day-start equity",
        f"daily loss limit of {lim.daily_loss_limit_pct:g}% reached; new exposure is blocked until 00:00 UTC")
    add("drawdown", "Drawdown breaker", exempt or not p.drawdown_halted,
        "tripped" if p.drawdown_halted else "ok", f"{lim.max_drawdown_pct:g}% from peak",
        f"maximum drawdown of {lim.max_drawdown_pct:g}% reached; new exposure is blocked until the breaker is reset")
    # 2. abnormal activity and fat-finger protection (apply to every order)
    n = p.orders_last_minute + 1
    add("order_rate", "Order rate", n <= lim.max_orders_per_minute, f"{n} in 60s", f"{lim.max_orders_per_minute} per minute",
        f"abnormal activity: {n} orders in 60 seconds (limit {lim.max_orders_per_minute})")
    if p.collar_through_pct is not None:
        add("price_collar", "Price collar", p.collar_through_pct <= lim.price_collar_pct,
            f"{p.collar_through_pct:.2f}% through market", f"{lim.price_collar_pct:g}%",
            f"limit price is {p.collar_through_pct:.2f}% through the market (collar {lim.price_collar_pct:g}%)")
    if exempt:
        return checks
    # 3. sizing (exposure-increasing orders only)
    rp = _pct(p.risk_amount, p.equity)
    add("risk_per_trade", "Risk per trade", rp <= lim.risk_per_trade_pct + 1e-9, f"{rp:.2f}% of equity",
        f"{lim.risk_per_trade_pct:g}%", f"trade risks {rp:.2f}% of equity to its stop (limit {lim.risk_per_trade_pct:g}%)")
    pp = _pct(p.position_after, p.equity)
    add("position_size", "Position size", pp <= lim.max_position_pct + 1e-9, f"{pp:.1f}% of equity",
        f"{lim.max_position_pct:g}%", f"position would be {pp:.1f}% of equity (limit {lim.max_position_pct:g}%)")
    ep = _pct(p.exposure_after, p.equity)
    add("gross_exposure", "Gross exposure", ep <= lim.max_gross_exposure_pct + 1e-9, f"{ep:.1f}% of equity",
        f"{lim.max_gross_exposure_pct:g}%", f"gross exposure would be {ep:.1f}% of equity (limit {lim.max_gross_exposure_pct:g}%)")
    add("open_positions", "Open positions", p.open_positions_after <= lim.max_open_positions,
        str(p.open_positions_after), str(lim.max_open_positions), f"maximum of {lim.max_open_positions} open positions reached")
    return checks


def first_failure(checks: list[Check]) -> str | None:
    return next((c.message for c in checks if not c.passed), None)
