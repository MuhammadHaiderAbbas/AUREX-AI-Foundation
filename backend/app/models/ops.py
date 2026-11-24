"""Operations records (Phase 12)."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, BigInteger, DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base, utcnow


class AuditAnchor(Base):
    """Append-only: each row records the audit chain head that was written outside the database."""

    __tablename__ = "audit_anchors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(),
                                                 default=utcnow, index=True)
    last_record_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    head_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    records: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sinks: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
