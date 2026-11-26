"""More real crypto instruments (Coinbase): XRP, DOGE, ADA, AVAX, LINK, LTC, DOT, BCH and PAX Gold.

Revision ID: 0014
Revises: 0013
"""
import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (symbol, display, asset_code, asset_name, decimals, tick, reference_price)
COINS = [
    ("XRP-USD", "XRP / US Dollar", "XRP", "XRP", 4, "0.0001", "0.95"),
    ("DOGE-USD", "Dogecoin / US Dollar", "DOGE", "Dogecoin", 5, "0.00001", "0.057"),
    ("ADA-USD", "Cardano / US Dollar", "ADA", "Cardano", 5, "0.00001", "0.15"),
    ("AVAX-USD", "Avalanche / US Dollar", "AVAX", "Avalanche", 3, "0.001", "6.66"),
    ("LINK-USD", "Chainlink / US Dollar", "LINK", "Chainlink", 3, "0.001", "9.23"),
    ("LTC-USD", "Litecoin / US Dollar", "LTC", "Litecoin", 3, "0.001", "43.6"),
    ("DOT-USD", "Polkadot / US Dollar", "DOT", "Polkadot", 4, "0.0001", "0.68"),
    ("BCH-USD", "Bitcoin Cash / US Dollar", "BCH", "Bitcoin Cash", 2, "0.01", "207"),
    ("PAXG-USD", "PAX Gold (tracks gold) / US Dollar", "PAXG", "PAX Gold", 2, "0.01", "3560"),
]


def upgrade() -> None:
    assets = sa.table("assets", sa.column("id", sa.Uuid), sa.column("code", sa.String), sa.column("name", sa.String),
                      sa.column("asset_class", sa.String))
    instruments = sa.table("instruments", *[sa.column(c) for c in (
        "id", "asset_id", "symbol", "display_name", "asset_class", "instrument_type", "venue", "market", "base_currency",
        "quote_currency", "price_decimals", "tick_size", "lot_size", "data_provider", "provider_symbol", "reference_price",
        "is_active")])
    conn = op.get_bind()
    for sym, disp, code, name, dec, tick, ref in COINS:
        if conn.execute(sa.text("SELECT 1 FROM instruments WHERE symbol = :s"), {"s": sym}).first():
            continue
        aid = conn.execute(sa.text("SELECT id FROM assets WHERE code = :c"), {"c": code}).scalar()
        if aid is None:
            aid = uuid.uuid4()
            op.bulk_insert(assets, [{"id": aid, "code": code, "name": name, "asset_class": "CRYPTO"}])
        op.bulk_insert(instruments, [{
            "id": uuid.uuid4(), "asset_id": aid, "symbol": sym, "display_name": disp, "asset_class": "CRYPTO",
            "instrument_type": "SPOT", "venue": "COINBASE", "market": "CRYPTO_24_7", "base_currency": code,
            "quote_currency": "USD", "price_decimals": dec, "tick_size": tick, "lot_size": "0.00000001",
            "data_provider": "coinbase", "provider_symbol": sym, "reference_price": ref, "is_active": True}])


def downgrade() -> None:
    syms = [c[0] for c in COINS]
    op.execute(sa.text("DELETE FROM instruments WHERE symbol IN :s").bindparams(sa.bindparam("s", expanding=True, value=syms)))
    op.execute(sa.text("DELETE FROM assets WHERE code IN :c AND id NOT IN (SELECT asset_id FROM instruments)")
               .bindparams(sa.bindparam("c", expanding=True, value=[c[2] for c in COINS])))
