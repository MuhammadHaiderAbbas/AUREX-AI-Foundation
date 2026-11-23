from datetime import UTC, datetime, timedelta

from app.market import calendar
from app.market.types import Market


def dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=UTC)


def test_crypto_always_open():
    assert calendar.is_open(Market.CRYPTO_24_7, dt("2026-11-28T03:00"))  # Saturday
    assert calendar.status(Market.CRYPTO_24_7, dt("2026-11-28T03:00"))["next_change"] is None


def test_fx_weekly_session_in_new_york_time():
    # November: New York is UTC-5, so the week opens Sun 22:00 UTC and closes Fri 22:00 UTC.
    assert not calendar.is_open(Market.FX_24_5, dt("2026-11-28T12:00"))   # Saturday
    assert not calendar.is_open(Market.FX_24_5, dt("2026-11-29T21:59"))   # Sunday before open
    assert calendar.is_open(Market.FX_24_5, dt("2026-11-29T22:00"))
    assert calendar.is_open(Market.FX_24_5, dt("2026-12-04T21:59"))       # Friday
    assert not calendar.is_open(Market.FX_24_5, dt("2026-12-04T22:00"))
    # July (EDT, UTC-4): close moves to 21:00 UTC
    assert not calendar.is_open(Market.FX_24_5, dt("2026-07-10T21:30"))


def test_us_equity_hours_dst_and_holidays():
    assert calendar.is_open(Market.US_EQUITY, dt("2026-11-23T14:30"))     # Mon 09:30 EST
    assert not calendar.is_open(Market.US_EQUITY, dt("2026-11-23T14:29"))
    assert not calendar.is_open(Market.US_EQUITY, dt("2026-11-23T21:00"))
    assert not calendar.is_open(Market.US_EQUITY, dt("2026-11-26T16:00"))  # Thanksgiving
    assert calendar.is_open(Market.US_EQUITY, dt("2026-07-15T13:30"))      # EDT open
    st = calendar.status(Market.US_EQUITY, dt("2026-11-25T22:00"))         # Wed evening
    assert st["is_open"] is False and st["next_change"] == dt("2026-11-27T14:30")


def test_uk_equity_hours_and_bank_holidays():
    assert calendar.is_open(Market.UK_EQUITY, dt("2026-11-23T08:00"))      # GMT
    assert not calendar.is_open(Market.UK_EQUITY, dt("2026-11-23T16:30"))
    assert calendar.is_open(Market.UK_EQUITY, dt("2026-07-15T07:00"))      # BST: 08:00 local
    assert not calendar.is_open(Market.UK_EQUITY, dt("2026-12-28T10:00"))  # Boxing Day (sub)


def test_sessions_are_clipped_and_last_close():
    start, end = dt("2026-11-23T15:00"), dt("2026-11-24T15:00")
    s = calendar.sessions(Market.US_EQUITY, start, end)
    assert s == [(dt("2026-11-23T15:00"), dt("2026-11-23T21:00")),
                 (dt("2026-11-24T14:30"), dt("2026-11-24T15:00"))]
    assert calendar.last_close(Market.US_EQUITY, dt("2026-11-30T10:00")) == dt("2026-11-27T21:00")
    assert calendar.last_close(Market.CRYPTO_24_7, dt("2026-11-30T10:00")) is None
    assert calendar.sessions(Market.FX_24_5, end, start) == []
    assert len(calendar.sessions(Market.FX_24_5, start, start + timedelta(days=21))) == 4
