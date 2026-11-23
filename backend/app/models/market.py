import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    PrimaryKeyConstraint,
    String,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base, Timestamps, UUIDPk, utcnow

PRICE = Numeric(28, 10)


class Asset(UUIDPk, Base):
    """An economic asset (Bitcoin, Apple Inc., Euro). One asset → many instruments."""

    __tablename__ = "assets"
    __table_args__ = (
        CheckConstraint("asset_class IN ('CRYPTO','FX','STOCK','ETF')", name="class_valid"),
    )

    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    asset_class: Mapped[str] = mapped_column(String(8), nullable=False)


class Instrument(UUIDPk, Timestamps, Base):
    """A tradable listing of an asset on a venue in a quote currency.

    `instrument_type` distinguishes cash instruments (SPOT, SPOT_FX, SHARE, ETF) from
    derivatives (CFD, PERP, FUTURE) added later — they differ in leverage, costs and
    regulatory treatment and must never be conflated.
    """

    __tablename__ = "instruments"
    __table_args__ = (
        CheckConstraint("asset_class IN ('CRYPTO','FX','STOCK','ETF')", name="class_valid"),
        CheckConstraint(
            "market IN ('CRYPTO_24_7','FX_24_5','US_EQUITY','UK_EQUITY')", name="market_valid"),
        CheckConstraint(
            "instrument_type IN ('SPOT','SPOT_FX','SHARE','ETF')", name="type_valid"),
    )

    asset_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("assets.id"), nullable=False)
    symbol: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    asset_class: Mapped[str] = mapped_column(String(8), nullable=False, index=True)
    instrument_type: Mapped[str] = mapped_column(String(8), nullable=False)
    venue: Mapped[str] = mapped_column(String(16), nullable=False)
    market: Mapped[str] = mapped_column(String(16), nullable=False)
    base_currency: Mapped[str] = mapped_column(String(8), nullable=False)
    quote_currency: Mapped[str] = mapped_column(String(3), nullable=False)
    price_decimals: Mapped[int] = mapped_column(Integer, nullable=False)
    tick_size: Mapped[Decimal] = mapped_column(PRICE, nullable=False)
    lot_size: Mapped[Decimal] = mapped_column(PRICE, nullable=False)
    data_provider: Mapped[str] = mapped_column(String(16), nullable=False)
    provider_symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    reference_price: Mapped[Decimal] = mapped_column(PRICE, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    asset: Mapped[Asset] = relationship(lazy="joined")


class MarketCandle(Base):
    __tablename__ = "market_candles"
    __table_args__ = (
        PrimaryKeyConstraint("instrument_id", "timeframe", "open_time"),
        CheckConstraint("high >= low AND high >= open AND high >= close "
                        "AND low <= open AND low <= close", name="ohlc_consistent"),
        CheckConstraint("volume >= 0", name="volume_nonneg"),
    )

    instrument_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("instruments.id", ondelete="CASCADE"), nullable=False)
    timeframe: Mapped[str] = mapped_column(String(4), nullable=False)
    open_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    open: Mapped[Decimal] = mapped_column(PRICE, nullable=False)
    high: Mapped[Decimal] = mapped_column(PRICE, nullable=False)
    low: Mapped[Decimal] = mapped_column(PRICE, nullable=False)
    close: Mapped[Decimal] = mapped_column(PRICE, nullable=False)
    volume: Mapped[Decimal] = mapped_column(Numeric(38, 10), nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), default=utcnow)


class Watchlist(UUIDPk, Timestamps, Base):
    __tablename__ = "watchlists"
    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_watchlist_user_name"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(60), nullable=False)

    items: Mapped[list["WatchlistItem"]] = relationship(
        lazy="selectin", cascade="all, delete-orphan", order_by="WatchlistItem.position")


class WatchlistItem(Base):
    __tablename__ = "watchlist_items"
    __table_args__ = (PrimaryKeyConstraint("watchlist_id", "instrument_id"),)

    watchlist_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("watchlists.id", ondelete="CASCADE"), nullable=False)
    instrument_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("instruments.id", ondelete="CASCADE"), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    instrument: Mapped[Instrument] = relationship(lazy="joined")
