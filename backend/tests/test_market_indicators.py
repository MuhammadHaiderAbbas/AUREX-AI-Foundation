import math

import pytest

from app.market import indicators as ind


def test_sma_and_ema():
    v = [1.0, 2, 3, 4, 5]
    assert ind.sma(v, 3) == [None, None, 2.0, 3.0, 4.0]
    e = ind.ema(v, 3)
    assert e[:2] == [None, None] and e[2] == 2.0
    assert e[3] == pytest.approx(3.0) and e[4] == pytest.approx(4.0)
    assert ind.ema([1.0], 3) == [None]


def test_rsi_bounds():
    up = [float(i) for i in range(30)]
    assert ind.rsi(up)[-1] == 100.0
    down = [float(30 - i) for i in range(30)]
    assert ind.rsi(down)[-1] == pytest.approx(0.0)
    zig = [100 + (1 if i % 2 else -1) for i in range(40)]
    assert 40 < ind.rsi([float(x) for x in zig])[-1] < 60
    assert ind.rsi([1.0, 2.0]) == [None, None]


def test_bollinger_and_macd_shapes():
    flat = [10.0] * 25
    bb = ind.bollinger(flat)
    assert bb["upper"][-1] == bb["lower"][-1] == 10.0 and bb["upper"][18] is None
    values = [100 + 10 * math.sin(i / 5) for i in range(80)]
    m = ind.macd(values)
    assert len(m["macd"]) == len(m["signal"]) == len(m["histogram"]) == 80
    assert m["macd"][24] is None and m["macd"][25] is not None
    assert m["signal"][33] is not None and m["signal"][32] is None


def test_compute_filters_unknown():
    out = ind.compute({"sma20", "nope"}, [1.0] * 30)
    assert set(out) == {"sma20"}
