import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base, UUIDPk, utcnow


class MLModel(UUIDPk, Base):
    """A model *specification*: instrument × timeframe × horizon × algorithm."""

    __tablename__ = "ml_models"
    __table_args__ = (
        UniqueConstraint("symbol", "timeframe", "horizon", "algorithm", name="uq_ml_model_spec"),
    )

    name: Mapped[str] = mapped_column(String(80), nullable=False)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    timeframe: Mapped[str] = mapped_column(String(4), nullable=False)
    horizon: Mapped[int] = mapped_column(Integer, nullable=False)
    algorithm: Mapped[str] = mapped_column(String(24), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), default=utcnow)

    versions: Mapped[list["ModelVersion"]] = relationship(
        back_populates="model", lazy="noload", order_by="ModelVersion.version.desc()")


class ModelVersion(UUIDPk, Base):
    """A trained, validated version. Promotion is a separate, gated, audited human action."""

    __tablename__ = "model_versions"
    __table_args__ = (
        UniqueConstraint("model_id", "version", name="uq_model_version"),
        CheckConstraint("status IN ('candidate','champion','retired')", name="status_valid"),
        # at most one champion per instrument/timeframe across all specifications
        Index("uq_champion_per_symbol", "symbol", "timeframe", unique=True,
              postgresql_where=text("status = 'champion'")),
    )

    model_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("ml_models.id", ondelete="CASCADE"),
                                                nullable=False, index=True)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    timeframe: Mapped[str] = mapped_column(String(4), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="candidate")
    eligible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    eligibility_note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    gates: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False)
    metrics: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    params: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    features: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    feature_importance: Mapped[dict[str, float]] = mapped_column(JSON, nullable=False)
    reference: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    data_source: Mapped[str] = mapped_column(String(24), nullable=False)
    train_from: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    train_to: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    n_samples: Mapped[int] = mapped_column(Integer, nullable=False)
    artifact: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, deferred=True)
    artifact_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    # HMAC-SHA256 with a server-held key; required before an artifact is unpickled (Phase 11).
    artifact_hmac: Mapped[str | None] = mapped_column(String(64))
    trained_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    trained_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    promoted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    promoted_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    model: Mapped[MLModel] = relationship(back_populates="versions", lazy="joined")


class ModelEvaluation(UUIDPk, Base):
    __tablename__ = "model_evaluations"
    __table_args__ = (
        CheckConstraint("kind IN ('walk_forward','drift_check')", name="kind_valid"),
    )

    version_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("model_versions.id", ondelete="CASCADE"),
                                                  nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False)
    metrics: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), default=utcnow, index=True)
