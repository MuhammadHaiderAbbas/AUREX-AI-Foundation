import { useQuery } from "@tanstack/react-query";
import { useCryptoGlobal, useCryptoMarkets } from "@/features/markets/CryptoOverview";

/**
 * Public market data for the website (no sign-in): CoinGecko for crypto and Coinbase's public
 * exchange-rates API for forex. Both are keyless, allow browser requests and are on the CSP
 * allow-lists of the demo and the server build.
 */
export { useCryptoGlobal, useCryptoMarkets };

const FX = [
  { symbol: "EUR/USD", name: "Euro / US Dollar", ccy: "EUR", invert: true },
  { symbol: "GBP/USD", name: "British Pound / US Dollar", ccy: "GBP", invert: true },
  { symbol: "USD/JPY", name: "US Dollar / Japanese Yen", ccy: "JPY", invert: false },
  { symbol: "USD/CHF", name: "US Dollar / Swiss Franc", ccy: "CHF", invert: false },
  { symbol: "AUD/USD", name: "Australian Dollar / US Dollar", ccy: "AUD", invert: true },
  { symbol: "USD/CAD", name: "US Dollar / Canadian Dollar", ccy: "CAD", invert: false },
];

export function usePublicFx() {
  return useQuery({
    queryKey: ["public", "fx"], refetchInterval: 60_000, staleTime: 30_000, retry: 1,
    queryFn: async () => {
      const r = await fetch("https://api.coinbase.com/v2/exchange-rates?currency=USD");
      if (!r.ok) throw new Error(`rates ${r.status}`);
      const rates = ((await r.json()) as { data: { rates: Record<string, string> } }).data.rates;
      return FX.filter((p) => Number(rates[p.ccy]) > 0).map((p) => {
        const raw = Number(rates[p.ccy]);
        return { symbol: p.symbol, name: p.name, price: p.invert ? 1 / raw : raw };
      });
    },
  });
}
