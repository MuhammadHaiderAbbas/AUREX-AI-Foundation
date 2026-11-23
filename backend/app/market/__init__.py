"""Market data infrastructure (Phase 3).

Layers:
  calendar    trading sessions per market (crypto 24/7, FX 24/5, US & UK equities)
  providers   one interface, many sources (synthetic, Coinbase, Frankfurter/ECB)
  service     instrument registry, candle storage + gap-fill, quotes with staleness
  indicators  SMA / EMA / RSI / Bollinger / MACD
  stream      WebSocket quote fan-out
"""
