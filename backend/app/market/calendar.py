"""Trading-session calendars.

Simplifications (documented, to be replaced by an exchange-calendar feed in Phase 12):
  * Full-day exchange holidays for 2026-2027 are listed; early closes are not modelled.
  * FX trades Sunday 17:00 to Friday 17:00 New York time; holiday thin-liquidity days
    are treated as normal.
"""

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.market.types import Market

NY = ZoneInfo("America/New_York")
LONDON = ZoneInfo("Europe/London")

NYSE_HOLIDAYS = {date.fromisoformat(d) for d in [
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
    "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
    "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]}
LSE_HOLIDAYS = {date.fromisoformat(d) for d in [
    "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-08-31",
    "2026-12-25", "2026-12-28",
    "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31", "2027-08-30",
    "2027-12-27", "2027-12-28",
]}

_EQUITY = {
    Market.US_EQUITY: (NY, time(9, 30), time(16, 0), NYSE_HOLIDAYS),
    Market.UK_EQUITY: (LONDON, time(8, 0), time(16, 30), LSE_HOLIDAYS),
}

Session = tuple[datetime, datetime]


def _utc(d: date, t: time, tz: ZoneInfo) -> datetime:
    return datetime.combine(d, t, tzinfo=tz).astimezone(UTC)


def sessions(market: str, start: datetime, end: datetime) -> list[Session]:
    """Trading sessions (UTC, half-open) intersecting [start, end), clipped to it."""
    if start >= end:
        return []
    if market == Market.CRYPTO_24_7:
        return [(start, end)]

    raw: list[Session] = []
    if market == Market.FX_24_5:
        d = start.astimezone(NY).date() - timedelta(days=7)
        d -= timedelta(days=(d.weekday() + 1) % 7)  # back to Sunday
        while _utc(d, time(17), NY) < end:
            raw.append((_utc(d, time(17), NY), _utc(d + timedelta(days=5), time(17), NY)))
            d += timedelta(days=7)
    elif market in _EQUITY:
        tz, open_t, close_t, holidays = _EQUITY[market]
        d = start.astimezone(tz).date() - timedelta(days=1)
        last = end.astimezone(tz).date()
        while d <= last:
            if d.weekday() < 5 and d not in holidays:
                raw.append((_utc(d, open_t, tz), _utc(d, close_t, tz)))
            d += timedelta(days=1)
    else:
        raise ValueError(f"unknown market {market}")
    return [(max(s, start), min(e, end)) for s, e in raw if e > start and s < end]


def is_open(market: str, at: datetime) -> bool:
    return bool(sessions(market, at, at + timedelta(seconds=1)))


def last_close(market: str, at: datetime) -> datetime | None:
    """End of the most recent session that finished at or before `at`."""
    if market == Market.CRYPTO_24_7:
        return None
    past = sessions(market, at - timedelta(days=10), at)
    complete = [e for _, e in past if e < at]
    return complete[-1] if complete else None


def status(market: str, at: datetime) -> dict:
    """Open/closed now plus the next transition time (None = never closes)."""
    if market == Market.CRYPTO_24_7:
        return {"market": market, "is_open": True, "next_change": None}
    upcoming = sessions(market, at, at + timedelta(days=10))
    open_now = bool(upcoming) and upcoming[0][0] <= at
    if open_now:
        nxt = upcoming[0][1]
    else:
        nxt = upcoming[0][0] if upcoming else None
    return {"market": market, "is_open": open_now, "next_change": nxt}
