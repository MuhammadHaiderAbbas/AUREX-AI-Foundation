import type { DemoInstrument } from "./market";

// Mirror of the registry seeded by backend migrations 0002 and 0014 (lot sizes per 0012: fractional shares, 1-unit FX).
const row = (symbol: string, display_name: string, asset_class: DemoInstrument["asset_class"], instrument_type: string,
  venue: string, market: DemoInstrument["market"], base_currency: string, quote_currency: string,
  price_decimals: number, tick_size: string, lot_size: string, reference_price: number): DemoInstrument =>
  ({ symbol, display_name, asset_class, instrument_type, venue, market, base_currency, quote_currency, price_decimals, tick_size, lot_size, reference_price });

export const INSTRUMENTS: DemoInstrument[] = [
  row("BTC-USD", "Bitcoin / US Dollar", "CRYPTO", "SPOT", "COINBASE", "CRYPTO_24_7", "BTC", "USD", 2, "0.01", "0.00000001", 90000),
  row("ETH-USD", "Ethereum / US Dollar", "CRYPTO", "SPOT", "COINBASE", "CRYPTO_24_7", "ETH", "USD", 2, "0.01", "0.00000001", 3200),
  row("SOL-USD", "Solana / US Dollar", "CRYPTO", "SPOT", "COINBASE", "CRYPTO_24_7", "SOL", "USD", 2, "0.01", "0.00000001", 160),
  row("XRP-USD", "XRP / US Dollar", "CRYPTO", "SPOT", "COINBASE", "CRYPTO_24_7", "XRP", "USD", 4, "0.0001", "0.00000001", 0.95),
  row("DOGE-USD", "Dogecoin / US Dollar", "CRYPTO", "SPOT", "COINBASE", "CRYPTO_24_7", "DOGE", "USD", 5, "0.00001", "0.00000001", 0.057),
  row("ADA-USD", "Cardano / US Dollar", "CRYPTO", "SPOT", "COINBASE", "CRYPTO_24_7", "ADA", "USD", 5, "0.00001", "0.00000001", 0.15),
  row("AVAX-USD", "Avalanche / US Dollar", "CRYPTO", "SPOT", "COINBASE", "CRYPTO_24_7", "AVAX", "USD", 3, "0.001", "0.00000001", 6.66),
  row("LINK-USD", "Chainlink / US Dollar", "CRYPTO", "SPOT", "COINBASE", "CRYPTO_24_7", "LINK", "USD", 3, "0.001", "0.00000001", 9.23),
  row("BCH-USD", "Bitcoin Cash / US Dollar", "CRYPTO", "SPOT", "COINBASE", "CRYPTO_24_7", "BCH", "USD", 2, "0.01", "0.00000001", 207),
  row("LTC-USD", "Litecoin / US Dollar", "CRYPTO", "SPOT", "COINBASE", "CRYPTO_24_7", "LTC", "USD", 3, "0.001", "0.00000001", 43.6),
  row("DOT-USD", "Polkadot / US Dollar", "CRYPTO", "SPOT", "COINBASE", "CRYPTO_24_7", "DOT", "USD", 4, "0.0001", "0.00000001", 0.68),
  row("PAXG-USD", "PAX Gold (tracks gold) / US Dollar", "CRYPTO", "SPOT", "COINBASE", "CRYPTO_24_7", "PAXG", "USD", 2, "0.01", "0.00000001", 3560),
  row("EUR/USD", "Euro / US Dollar", "FX", "SPOT_FX", "OTC", "FX_24_5", "EUR", "USD", 5, "0.00001", "1", 1.08),
  row("GBP/USD", "British Pound / US Dollar", "FX", "SPOT_FX", "OTC", "FX_24_5", "GBP", "USD", 5, "0.00001", "1", 1.27),
  row("USD/JPY", "US Dollar / Japanese Yen", "FX", "SPOT_FX", "OTC", "FX_24_5", "USD", "JPY", 3, "0.001", "1", 150),
  row("AAPL", "Apple Inc.", "STOCK", "SHARE", "NASDAQ", "US_EQUITY", "AAPL", "USD", 2, "0.01", "0.0001", 230),
  row("MSFT", "Microsoft Corporation", "STOCK", "SHARE", "NASDAQ", "US_EQUITY", "MSFT", "USD", 2, "0.01", "0.0001", 420),
  row("NVDA", "NVIDIA Corporation", "STOCK", "SHARE", "NASDAQ", "US_EQUITY", "NVDA", "USD", 2, "0.01", "0.0001", 140),
  row("SHEL.L", "Shell plc", "STOCK", "SHARE", "LSE", "UK_EQUITY", "SHEL", "GBP", 2, "0.01", "0.0001", 26),
  row("AZN.L", "AstraZeneca plc", "STOCK", "SHARE", "LSE", "UK_EQUITY", "AZN", "GBP", 2, "0.01", "0.0001", 110),
  row("SPY", "SPDR S&P 500 ETF Trust", "ETF", "ETF", "NYSEARCA", "US_EQUITY", "SPY", "USD", 2, "0.01", "0.0001", 590),
  row("QQQ", "Invesco QQQ Trust", "ETF", "ETF", "NASDAQ", "US_EQUITY", "QQQ", "USD", 2, "0.01", "0.0001", 510),
  row("ISF.L", "iShares Core FTSE 100 UCITS ETF", "ETF", "ETF", "LSE", "UK_EQUITY", "ISF", "GBP", 2, "0.01", "0.0001", 8.5),
];
