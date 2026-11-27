"""Remove the 30-second binary expiry.

Bots set to 30 seconds move to 1 minute, and recorded 30-second bars are deleted. Settled
30-second contracts stay in history.

Revision ID: 0017
Revises: 0016
"""

from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE binary_bots SET expiry_seconds = 60 WHERE expiry_seconds = 30")
    op.execute("DELETE FROM market_candles WHERE timeframe = '30s'")


def downgrade() -> None:
    pass  # data-only
