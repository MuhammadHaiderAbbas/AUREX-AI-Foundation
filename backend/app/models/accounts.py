import uuid

from sqlalchemy import CheckConstraint, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base, Timestamps, UUIDPk


class AccountMode:
    PAPER = "PAPER"
    LIVE = "LIVE"  # reserved — rejected by a DB check constraint in Stage 1


class AccountStatus:
    ACTIVE = "ACTIVE"
    CLOSED = "CLOSED"


class TradingAccount(UUIDPk, Timestamps, Base):
    __tablename__ = "trading_accounts"
    __table_args__ = (
        CheckConstraint("mode = 'PAPER'", name="paper_only"),
        CheckConstraint("status IN ('ACTIVE','CLOSED')", name="status_valid"),
    )

    owner_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    mode: Mapped[str] = mapped_column(String(8), nullable=False, default=AccountMode.PAPER)
    base_currency: Mapped[str] = mapped_column(String(3), nullable=False)
    status: Mapped[str] = mapped_column(String(8), nullable=False, default=AccountStatus.ACTIVE)
