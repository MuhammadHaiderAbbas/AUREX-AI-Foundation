import { X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { app } from "@/lib/paths";

/**
 * Beginner tour: a spotlight on one part of the screen at a time, with plain-English text.
 * Starts by itself the first time someone opens the Dashboard or the Trade screen (remembered per
 * browser), and can be replayed from the account menu ("Take the tour"). It does not start on its
 * own in automated browsers (navigator.webdriver), so end-to-end tests start it explicitly.
 */
export type TourName = "dashboard" | "trade" | "futures";
interface Step { target?: string; title: string; body: ReactNode; next?: { label: string; tour: TourName; path: string } }

const TOURS: Record<TourName, Step[]> = {
  dashboard: [
    { title: "Welcome to AUREX", body: "This one-minute tour shows you around. Everything here uses virtual money, so nothing you do can lose real money." },
    { target: "nav", title: "The main menu", body: "Dashboard is home. Trade has charts and orders, Futures lets you go long or short with leverage, AI Desk asks the AI agents, Research answers questions, and Portfolio and Analytics show how you are doing. More holds your wallet, risk limits, backtesting and binary options." },
    { target: "ticker", title: "Live prices", body: "Crypto and forex prices update live. Click any of them to open it on the Trade screen." },
    { target: "stats", title: "Your account at a glance", body: "Equity is what your account is worth right now, cash is what you can still spend, and drawdown is how far you are below your best value. The risk engine stops trading if losses get too big." },
    { target: "equity", title: "Live equity chart", body: "This line moves as prices move, once you hold something. With only cash it stays flat, which is normal." },
    { target: "new-account", title: "Paper accounts", body: "Start with £100, or open more accounts in other currencies or sizes to try different ideas side by side." },
    { target: "alerts-bell", title: "Price alerts", body: "Get told when a market rises above or falls below a price you choose. Alerts you set on the Trade screen show up here, and as a desktop notification if you allow it." },
    { target: "user-menu", title: "Profile, security and this tour", body: "Change your name, turn on two-factor sign-in, download your data, or take this tour again." },
    { target: "coach", title: "Ask the coach", body: "Not sure why something happened? Ask the coach: “why is my bot losing?”, “why did the AI say no trade?”, or “what is leverage?”. It answers from your own account data." },
    { title: "Next: the Trade screen", body: "See the chart, place a paper trade and set your first price alert.", next: { label: "Show me the Trade screen", tour: "trade", path: "/trade?symbol=BTC-USD" } },
  ],
  trade: [
    { target: "watchlist", title: "Pick a market", body: "Your watchlist and every market by type. The star adds or removes a market from your watchlist." },
    { target: "chart", title: "The chart", body: "Each candle shows how the price moved in one period. Change the period with 5m, 1h or 1d, and switch on indicators such as moving averages (SMA) or RSI to see trends and momentum." },
    { target: "trade-panel", title: "Buy and sell", body: "Buy if you think the price will rise, Sell to close or reduce what you hold. You can trade small fractions, so £100 is enough. Every order is checked by the risk engine first." },
    { target: "alert-panel", title: "Set a price alert", body: "Choose “rises above” or “falls below”, type a price and press Set alert. You'll get a notification when it happens, even on another page of the app." },
    { target: "ai-link", title: "Ask the AI", body: "Eight AI agents look at this market from different angles and explain whether they would trade, and why. Often the honest answer is “no trade”." },
    { target: "positions", title: "Your positions and orders", body: "What you hold, its profit or loss, and orders waiting to fill. Close a position with one click." },
    { title: "Next: futures", body: "Go long or short with leverage, see the real order book and ask the AI futures model.", next: { label: "Show me Futures", tour: "futures", path: "/futures" } },
  ],
  futures: [
    { target: "futures-bot", title: "The AI futures bot", body: "Press Start and it trades by itself: every 15 minutes it asks the AI model, and opens a position only when the model has a tested edge after fees. Every trade gets a stop-loss and closes after 4 hours. It pauses itself if it starts losing money." },
    { target: "futures-ticket", title: "Long, short and leverage", body: "Long gains when the price rises, short gains when it falls. Leverage multiplies both: at 5x a 1% move is 5% of your margin. Isolated margin means the most you can lose on a position is the margin you put in." },
    { target: "futures-preview", title: "Liquidation price", body: "If the price reaches this level your margin is used up and the position is closed automatically (liquidated). Higher leverage moves it closer to the current price." },
    { target: "order-book", title: "Real liquidity", body: "This is the live order book. Your order is filled level by level, so a bigger order gets a slightly worse average price (slippage), and an order bigger than the book is refused." },
    { target: "futures-ai", title: "The AI futures model", body: "It is trained on hourly history and tested on data it never saw, after fees and funding. It only says LONG or SHORT when the tested edge is clearly positive; most of the time it says no trade." },
    { target: "futures-positions", title: "Positions and funding", body: "Every 8 hours longs pay shorts a small funding fee (or the other way round), taken from or added to the margin. Close a position at any time with one click." },
    { title: "You're ready", body: "That's the tour. Take it again any time from the account menu (your initials, top right). Happy paper trading!" },
  ],
};

const KEY = (t: TourName) => `aurex-tour-done:${t}`;
const isDone = (t: TourName) => { try { return localStorage.getItem(KEY(t)) === "1"; } catch { return true; } };
const markDone = (t: TourName) => { try { localStorage.setItem(KEY(t), "1"); } catch { /* storage blocked */ } };

const Ctx = createContext<{ start: (t: TourName) => void; active: TourName | null }>({ start: () => {}, active: null });
export const useTour = () => useContext(Ctx);

/** Start a tour automatically the first time this page is shown (not in automated browsers). */
export function useAutoTour(t: TourName, ready = true) {
  const { start, active } = useTour();
  useEffect(() => {
    if (!ready || active || isDone(t) || (typeof navigator !== "undefined" && navigator.webdriver)) return;
    const id = setTimeout(() => start(t), 900);       // let the page lay out first
    return () => clearTimeout(id);
  }, [t, ready, active, start]);
}

function useRect(selector: string | undefined, step: number) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!selector) { setRect(null); return; }
    let frame = 0;
    const measure = () => {
      const el = document.querySelector(`[data-tour="${selector}"]`);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    const el = document.querySelector(`[data-tour="${selector}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    measure();
    const tick = () => { measure(); frame = requestAnimationFrame(tick); };   // follow smooth scrolling and resizes
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [selector, step]);
  return rect;
}

function Overlay({ name, onClose, onNext }: { name: TourName; onClose: () => void; onNext: (t: TourName, path: string) => void }) {
  const steps = TOURS[name];
  const [i, setI] = useState(0);
  const step = steps[i]!;
  const rect = useRect(step.target, i);
  const last = i === steps.length - 1;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && !last) setI(i + 1);
      if (e.key === "ArrowLeft" && i > 0) setI(i - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [i, last, onClose]);

  const pad = 6;
  const card = 340;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280, vh = typeof window !== "undefined" ? window.innerHeight : 800;
  let pos: React.CSSProperties = { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
  if (rect) {
    const below = rect.bottom + 12 + 220 < vh;
    const left = Math.min(Math.max(12, rect.left + rect.width / 2 - card / 2), vw - card - 12);
    pos = below ? { left, top: rect.bottom + 12 } : { left, top: Math.max(12, rect.top - 12), transform: "translateY(-100%)" };
    if (rect.height > vh * 0.6) pos = { left: Math.min(rect.right + 12, vw - card - 12), top: Math.max(12, Math.min(rect.top + 40, vh - 260)) };
  }
  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label="Guided tour" data-testid="tour">
      {rect ? (
        <div className="pointer-events-none fixed rounded-xl transition-all duration-200"
          style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2,
            boxShadow: "0 0 0 9999px rgba(5,7,10,0.72), 0 0 0 2px var(--color-accent)" }} />
      ) : <div className="fixed inset-0 bg-[rgba(5,7,10,0.72)]" />}
      <div className="fixed w-[340px] max-w-[calc(100vw-24px)] rounded-2xl border border-border bg-surface-2 p-5 shadow-2xl shadow-black/60" style={pos}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold">{step.title}</h2>
          <button onClick={onClose} aria-label="Close tour" className="text-muted hover:text-fg"><X className="size-4" /></button>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
        <div className="mt-5 flex items-center justify-between gap-3">
          <span className="num text-xs text-subtle">{i + 1} / {steps.length}</span>
          <div className="flex gap-2">
            {i > 0 && <Button size="sm" variant="ghost" onClick={() => setI(i - 1)}>Back</Button>}
            {!last && <Button size="sm" variant="ghost" onClick={onClose}>Skip</Button>}
            {step.next ? <Button size="sm" onClick={() => onNext(step.next!.tour, step.next!.path)}>{step.next.label}</Button>
              : last ? <Button size="sm" onClick={onClose}>Finish</Button>
              : <Button size="sm" onClick={() => setI(i + 1)}>Next</Button>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function TourProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<TourName | null>(null);
  const navigate = useNavigate();
  const start = useCallback((t: TourName) => {
    if (t === "dashboard" && !location.pathname.replace(/\/$/, "").endsWith("/app")) navigate(app());
    setActive(t);
  }, [navigate]);
  const close = useCallback(() => { if (active) markDone(active); setActive(null); }, [active]);
  const next = useCallback((t: TourName, path: string) => {
    if (active) markDone(active);
    setActive(null);
    navigate(app(path));
    setTimeout(() => setActive(t), 900);
  }, [active, navigate]);
  const value = useMemo(() => ({ start, active }), [start, active]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {active && <Overlay key={active} name={active} onClose={close} onNext={next} />}
    </Ctx.Provider>
  );
}
