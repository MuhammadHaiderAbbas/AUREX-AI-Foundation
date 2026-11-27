import { ChevronDown, Compass, LogOut, MoreHorizontal, Settings, ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { Brand } from "@/components/site/Brand";
import { StatusDot } from "@/components/ui/badge";
import { useAuth } from "@/features/auth/AuthProvider";
import { useAccountStream, useLiveMode } from "@/features/live/stream";
import { useLiveQuotes, useMarketOverview } from "@/features/markets/hooks";
import { useSystemHalt } from "@/features/risk/hooks";
import { app } from "@/lib/paths";
import { cn, formatPct, formatPrice } from "@/lib/utils";
import { isDemo } from "@/services/api";
import { AlertBell } from "@/features/alerts/AlertBell";
import { TourProvider, useTour } from "@/features/tour/GuidedTour";
import { APP_MORE, APP_NAV, type NavItem } from "./nav";

/** Kept for older imports: the product logo. */
export function Logo({ className }: { className?: string }) { return <Brand className={className} />; }

function useOutside(ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    const on = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, [ref, close]);
}

function Menu({ label, children, align = "right", testId }: { label: ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; testId?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useOutside(ref, close);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" data-testid={testId}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg">{label}</button>
      {open && (
        <div role="menu" className={cn("absolute z-50 mt-1.5 w-64 overflow-hidden rounded-xl border border-border bg-surface-2 p-1.5 shadow-2xl shadow-black/50", align === "right" ? "right-0" : "left-0")}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

function MenuLink({ item, onClick }: { item: NavItem; onClick: () => void }) {
  return (
    <NavLink to={item.to} end={item.end} onClick={onClick} role="menuitem"
      className={({ isActive }) => cn("flex items-start gap-3 rounded-lg px-3 py-2", isActive ? "bg-surface-3" : "hover:bg-surface-3")}>
      <item.icon className="mt-0.5 size-4 shrink-0 text-muted" />
      <span><span className="block text-sm text-fg">{item.label}</span><span className="block text-xs text-subtle">{item.description}</span></span>
    </NavLink>
  );
}

function LiveDot() {
  const { mode } = useLiveMode();
  const tone = mode === "live" || mode === "polling" ? "positive" : mode === "connecting" ? "warning" : "neutral";
  const label = mode === "live" ? "Live" : mode === "polling" ? "Live · polling" : mode === "connecting" ? "Connecting" : "Offline";
  return (
    <span data-testid="live-status" className="hidden items-center gap-1.5 text-xs text-muted sm:flex"
      title={mode === "polling" ? "Refreshing every 2 seconds" : mode === "live" ? "Streaming over a WebSocket" : "Live updates are not connected"}>
      <StatusDot tone={tone} />{label}
    </span>
  );
}

/** Live prices across the top of the app (crypto and forex from the platform's own quote stream). */
function AppTicker() {
  const overview = useMarketOverview();
  const rows = [...(overview.data?.groups.CRYPTO ?? []), ...(overview.data?.groups.FX ?? [])];
  const { quotes } = useLiveQuotes(rows.map((r) => r.instrument.symbol));
  if (!rows.length) return <div className="h-9 border-b border-border" />;
  const items = [...rows, ...rows];
  return (
    <div className="overflow-hidden border-b border-border bg-surface/60 print:hidden" data-testid="app-ticker" data-tour="ticker">
      <div className="animate-marquee flex w-max">
        {items.map((r, i) => {
          const q = quotes[r.instrument.symbol] ?? r.quote;
          const ch = q?.change_pct == null ? 0 : Number(q.change_pct);
          return (
            <Link key={`${r.instrument.symbol}-${i}`} to={app(`/trade?symbol=${r.instrument.slug}`)} aria-hidden={i >= rows.length} tabIndex={i >= rows.length ? -1 : 0}
              className="flex items-center gap-2 px-4 py-2 text-xs hover:bg-surface-2">
              <span className="font-semibold">{r.instrument.symbol}</span>
              <span className="num text-muted">{formatPrice(q?.last, r.instrument.price_decimals)}</span>
              <span className={cn("num", ch > 0 ? "text-positive" : ch < 0 ? "text-negative" : "text-subtle")}>{formatPct(q?.change_pct)}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function Avatar({ name }: { name?: string }) {
  const initials = (name ?? "?").split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return <span className="flex size-8 items-center justify-center rounded-full bg-accent/20 text-xs font-semibold text-accent">{initials}</span>;
}

function UserMenu() {
  const { user, logout } = useAuth();
  const tour = useTour();
  return (
    <div data-tour="user-menu"><Menu testId="user-menu" label={<><Avatar name={user?.full_name} /><ChevronDown className="hidden size-3.5 sm:block" /></>}>
      {(close) => (
        <>
          <div className="border-b border-border px-3 pt-2 pb-3">
            <div className="text-sm font-medium text-fg">{user?.full_name}</div>
            <div className="truncate text-xs text-subtle">{user?.email}</div>
          </div>
          <div className="py-1">
            <MenuLink onClick={close} item={{ to: app("/settings/profile"), label: "Profile", description: "Name, preferences and data", icon: UserRound }} />
            <MenuLink onClick={close} item={{ to: app("/settings/security"), label: "Security", description: "Password, two-factor sign-in and devices", icon: ShieldCheck }} />
            <MenuLink onClick={close} item={{ to: app("/settings/accounts"), label: "Paper accounts", description: "Create and manage your accounts", icon: Settings }} />
          </div>
          <button onClick={() => { close(); tour.start("dashboard"); }} role="menuitem"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-3 hover:text-fg">
            <Compass className="size-4" />Take the tour
          </button>
          <button onClick={() => { close(); void logout(); }} role="menuitem"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-3 hover:text-fg">
            <LogOut className="size-4" />Log out
          </button>
        </>
      )}
    </Menu></div>
  );
}

function TopNav() {
  const location = useLocation();
  const moreActive = APP_MORE.some((i) => location.pathname.startsWith(i.to));
  return (
    <nav aria-label="Main" className="hidden items-center gap-0.5 lg:flex" data-tour="nav">
      {APP_NAV.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end}
          className={({ isActive }) => cn("rounded-lg px-3 py-1.5 text-sm font-medium transition-colors", isActive ? "bg-surface-2 text-fg" : "text-muted hover:text-fg")}>
          {item.label}
        </NavLink>
      ))}
      <Menu align="left" label={<span className={cn("font-medium", moreActive && "text-fg")}>More <ChevronDown className="inline size-3.5" /></span>}>
        {(close) => APP_MORE.map((i) => <MenuLink key={i.to} item={i} onClick={close} />)}
      </Menu>
    </nav>
  );
}

function MobileTabs() {
  const tabs = [APP_NAV[0]!, APP_NAV[1]!, APP_NAV[2]!, APP_NAV[4]!];
  return (
    <nav aria-label="Mobile" className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-border bg-surface/95 backdrop-blur lg:hidden print:hidden">
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => cn("flex flex-col items-center gap-0.5 py-2 text-[11px]", isActive ? "text-accent" : "text-muted")}>
          <t.icon className="size-5" />{t.label}
        </NavLink>
      ))}
      <Menu align="right" label={<span className="flex flex-col items-center gap-0.5 text-[11px]"><MoreHorizontal className="size-5" />More</span>}>
        {(close) => [...APP_NAV.slice(3), ...APP_MORE].filter((i) => i !== APP_NAV[4]).map((i) => <MenuLink key={i.to} item={i} onClick={close} />)}
      </Menu>
    </nav>
  );
}

export function AppShell() {
  const halt = useSystemHalt();
  const auth = useAuth();
  useAccountStream(!!auth.user);
  const location = useLocation();
  const wide = location.pathname.startsWith(app("/trade"));
  return (
    <TourProvider>
    <div className="flex h-full flex-col">
      <header className="z-30 flex h-14 shrink-0 items-center gap-4 border-b border-border bg-surface px-4 print:hidden lg:px-5">
        <Brand to={app()} />
        <TopNav />
        <div className="ml-auto flex items-center gap-3">
          {halt.data?.halted && (
            <span className="flex items-center gap-1.5 rounded-md bg-negative/15 px-2 py-1 text-xs font-medium text-negative" title={halt.data.reason ?? ""}>
              <StatusDot tone="negative" />Trading halted
            </span>
          )}
          <span className="hidden rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted md:inline" title="Virtual money only. No real money is traded.">
            Paper{isDemo ? " · Demo" : ""}
          </span>
          <LiveDot />
          <AlertBell />
          <UserMenu />
        </div>
      </header>
      <AppTicker />
      <main className="flex-1 overflow-y-auto pb-16 print:overflow-visible lg:pb-0">
        <div className={cn("mx-auto", wide ? "max-w-none p-2 lg:p-3" : "max-w-[1440px] p-4 lg:p-6")}><Outlet /></div>
      </main>
      <MobileTabs />
    </div>
    </TourProvider>
  );
}
