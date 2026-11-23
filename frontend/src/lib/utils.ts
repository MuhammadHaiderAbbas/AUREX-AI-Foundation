import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Money arrives from the API as decimal strings. Keep it exact: scale to 1e-8 BigInt. */
const SCALE = 8;
export function toUnits(v: string): bigint {
  const neg = v.startsWith("-");
  const [whole = "0", frac = ""] = v.replace("-", "").split(".");
  const units = BigInt(whole) * 10n ** BigInt(SCALE) + BigInt((frac + "0".repeat(SCALE)).slice(0, SCALE));
  return neg ? -units : units;
}
export function fromUnits(u: bigint): string {
  const neg = u < 0n;
  const abs = neg ? -u : u;
  const s = abs.toString().padStart(SCALE + 1, "0");
  return `${neg ? "-" : ""}${s.slice(0, -SCALE)}.${s.slice(-SCALE)}`;
}
export function sumDecimals(values: string[]): string {
  return fromUnits(values.reduce((acc, v) => acc + toUnits(v), 0n));
}

export function formatMoney(value: string | number, currency = "USD", opts: { compact?: boolean } = {}) {
  const n = typeof value === "string" ? Number(value) : value;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    notation: opts.compact ? "compact" : "standard",
    minimumFractionDigits: opts.compact ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatDateTime(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(new Date(iso));
}

export function relativeTime(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
