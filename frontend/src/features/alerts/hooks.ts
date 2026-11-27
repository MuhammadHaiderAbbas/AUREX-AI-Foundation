import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "@/services/api";

export interface PriceAlert {
  id: string; symbol: string; direction: "ABOVE" | "BELOW"; price: string; note: string | null;
  status: "ACTIVE" | "TRIGGERED" | "CANCELLED"; created_at: string; triggered_at: string | null; triggered_price: string | null; seen_at: string | null;
}

export const useAlerts = (enabled = true) =>
  useQuery({ queryKey: ["alerts"], queryFn: () => api<PriceAlert[]>("/alerts"), refetchInterval: 5_000, enabled });

export function useCreateAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { symbol: string; direction: "ABOVE" | "BELOW"; price: string; note?: string }) =>
      api<PriceAlert>("/alerts", { method: "POST", json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });
}

export function useCancelAlert() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api(`/alerts/${id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }) });
}

export function useMarkAlertsSeen() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => api("/alerts/seen", { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }) });
}

export const alertText = (a: PriceAlert) => `${a.symbol} ${a.direction === "ABOVE" ? "rose above" : "fell below"} ${a.price}`;

/** A desktop notification for each alert that triggers while the app is open (only if the user allowed them). */
export function useAlertNotifications(alerts: PriceAlert[] | undefined) {
  const shown = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!alerts) return;
    const fired = alerts.filter((a) => a.status === "TRIGGERED" && !a.seen_at);
    if (shown.current === null) { shown.current = new Set(fired.map((a) => a.id)); return; }      // don't replay old ones on load
    for (const a of fired) {
      if (shown.current.has(a.id)) continue;
      shown.current.add(a.id);
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try { new Notification("AUREX price alert", { body: `${alertText(a)}${a.triggered_price ? ` (now ${a.triggered_price})` : ""}${a.note ? ` · ${a.note}` : ""}` }); } catch { /* not supported */ }
      }
    }
  }, [alerts]);
}
