"""US stocks and ETFs from Alpaca (real data when a key is configured); more instruments.

Adds TSLA, NFLX, DIA (Dow Jones ETF), GLD (gold ETF) and USO (oil ETF), and switches the US
stocks and ETFs to the "alpaca" provider. Without an Alpaca key they stay simulated.

Revision ID: 0015
Revises: 0014
"""
import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

US = ["AAPL", "MSFT", "NVDA", "SPY", "QQQ"]
# (symbol, display, asset_code, asset_name, class, type, venue, reference_price)
NEW = [
    ("TSLA", "Tesla, Inc.", "TSLA", "Tesla, Inc.", "STOCK", "SHARE", "NASDAQ", "380"),
    ("NFLX", "Netflix, Inc.", "NFLX", "Netflix, Inc.", "STOCK", "SHARE", "NASDAQ", "59.4"),
    ("DIA", "SPDR Dow Jones Industrial Average ETF", "DIA", "SPDR Dow Jones Industrial Average ETF", "ETF", "ETF", "NYSEARCA", "500"),
    ("GLD", "SPDR Gold Shares (tracks gold)", "GLD", "SPDR Gold Shares", "ETF", "ETF", "NYSEARCA", "330"),
    ("USO", "United States Oil Fund (tracks WTI crude)", "USO", "United States Oil Fund", "ETF", "ETF", "NYSEARCA", "80"),
]


def upgrade() -> None:
    assets = sa.table("assets", sa.column("id", sa.Uuid), sa.column("code", sa.String), sa.column("name", sa.String),
                      sa.column("asset_class", sa.String))
    instruments = sa.table("instruments", *[sa.column(c) for c in (
        "id", "asset_id", "symbol", "display_name", "asset_class", "instrument_type", "venue", "market", "base_currency",
        "quote_currency", "price_decimals", "tick_size", "lot_size", "data_provider", "provider_symbol", "reference_price",
        "is_active")])
    conn = op.get_bind()
    for sym, disp, code, name, cls, typ, venue, ref in NEW:
        if conn.execute(sa.text("SELECT 1 FROM instruments WHERE symbol = :s"), {"s": sym}).first():
            continue
        aid = conn.execute(sa.text("SELECT id FROM assets WHERE code = :c"), {"c": code}).scalar()
        if aid is None:
            aid = uuid.uuid4()
            op.bulk_insert(assets, [{"id": aid, "code": code, "name": name, "asset_class": cls}])
        op.bulk_insert(instruments, [{
            "id": uuid.uuid4(), "asset_id": aid, "symbol": sym, "display_name": disp, "asset_class": cls,
            "instrument_type": typ, "venue": venue, "market": "US_EQUITY", "base_currency": code, "quote_currency": "USD",
            "price_decimals": 2, "tick_size": "0.01", "lot_size": "0.0001", "data_provider": "alpaca", "provider_symbol": sym,
            "reference_price": ref, "is_active": True}])
    op.execute(sa.text("UPDATE instruments SET data_provider = 'alpaca' WHERE symbol IN :s")
               .bindparams(sa.bindparam("s", expanding=True, value=US)))


def downgrade() -> None:
    op.execute(sa.text("UPDATE instruments SET data_provider = 'synthetic' WHERE symbol IN :s")
               .bindparams(sa.bindparam("s", expanding=True, value=US)))
    syms = [n[0] for n in NEW]
    op.execute(sa.text("DELETE FROM instruments WHERE symbol IN :s").bindparams(sa.bindparam("s", expanding=True, value=syms)))
    op.execute(sa.text("DELETE FROM assets WHERE code IN :c AND id NOT IN (SELECT asset_id FROM instruments)")
               .bindparams(sa.bindparam("c", expanding=True, value=syms)))
