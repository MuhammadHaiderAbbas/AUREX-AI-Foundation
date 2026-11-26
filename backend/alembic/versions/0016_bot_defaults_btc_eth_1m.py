"""Binary bot defaults: BTC-USD and ETH-USD at 1-minute expiry.

Stopped or paused bots still on the earlier defaults (BTC-USD, ETH-USD, EUR/USD at 5 minutes)
move to the new ones; running bots and bots someone configured are left alone.

Revision ID: 0016
Revises: 0015
"""

from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""UPDATE binary_bots SET symbols = '["BTC-USD", "ETH-USD"]', expiry_seconds = 60
                  WHERE status <> 'RUNNING' AND symbols::text = '["BTC-USD", "ETH-USD", "EUR/USD"]' AND expiry_seconds = 300""")


def downgrade() -> None:
    pass  # data-only: the previous defaults are not restored
