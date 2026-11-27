import { Menu, X } from "lucide-react";
import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/AuthProvider";
import { MaintenanceBanner } from "@/features/platform/Maintenance";
import { homeFor } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { isDemo } from "@/services/api";
import { Brand } from "./Brand";

const LINKS = [
  { to: "/markets", label: "Markets" },
  { to: "/ai-trading", label: "AI Trading" },
  { to: "/security", label: "Security" },
  { to: "/about", label: "About" },
];

function SiteNav({ onNavigate, vertical = false }: { onNavigate?: () => void; vertical?: boolean }) {
  return (
    <nav aria-label="Site" className={cn("flex", vertical ? "flex-col gap-1" : "items-center gap-1")}>
      {LINKS.map((l) => (
        <NavLink key={l.to} to={l.to} onClick={onNavigate}
          className={({ isActive }) => cn("rounded-lg px-3 py-2 text-sm font-medium transition-colors",
            isActive ? "text-fg" : "text-muted hover:text-fg")}>{l.label}</NavLink>
      ))}
    </nav>
  );
}

function AuthButtons({ onNavigate }: { onNavigate?: () => void }) {
  const { status, user } = useAuth();
  if (status === "authenticated") {
    return <Link to={homeFor(user?.role)} onClick={onNavigate}><Button size="sm">{user?.role === "admin" ? "Admin console" : "Open app"}</Button></Link>;
  }
  return (
    <div className="flex items-center gap-2">
      <Link to="/login" onClick={onNavigate}><Button size="sm" variant="ghost">Log in</Button></Link>
      <Link to="/register" onClick={onNavigate}><Button size="sm">Sign up</Button></Link>
    </div>
  );
}

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-bg/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 lg:px-6">
        <Brand />
        <div className="hidden flex-1 md:block"><SiteNav /></div>
        <div className="ml-auto hidden md:block"><AuthButtons /></div>
        <button className="ml-auto text-muted md:hidden" onClick={() => setOpen(!open)} aria-label={open ? "Close menu" : "Open menu"}>
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>
      {open && (
        <div className="space-y-3 border-t border-border px-4 py-4 md:hidden">
          <SiteNav vertical onNavigate={() => setOpen(false)} />
          <AuthButtons onNavigate={() => setOpen(false)} />
        </div>
      )}
    </header>
  );
}

const FOOTER: { title: string; links: { to: string; label: string }[] }[] = [
  { title: "Product", links: [{ to: "/markets", label: "Markets" }, { to: "/ai-trading", label: "AI Trading" }, { to: "/register", label: "Create account" }] },
  { title: "Company", links: [{ to: "/about", label: "About" }, { to: "/security", label: "Security" }] },
  { title: "Legal", links: [{ to: "/legal/terms", label: "Terms of use" }, { to: "/legal/privacy", label: "Privacy policy" }, { to: "/legal/risk", label: "Risk disclosure" }] },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-surface/40">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 md:grid-cols-[1.4fr_repeat(3,1fr)] lg:px-6">
        <div className="space-y-3">
          <Brand />
          <p className="max-w-xs text-sm text-muted">An AI trading desk that explains every decision and knows when not to trade. Paper trading with virtual money.</p>
        </div>
        {FOOTER.map((c) => (
          <div key={c.title}>
            <h4 className="text-sm font-semibold">{c.title}</h4>
            <ul className="mt-3 space-y-2">
              {c.links.map((l) => <li key={l.to}><Link to={l.to} className="text-sm text-muted hover:text-fg">{l.label}</Link></li>)}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border">
        <p className="mx-auto max-w-7xl px-4 py-5 text-xs leading-relaxed text-subtle lg:px-6">
          AUREX AI is a paper-trading and research platform: all balances are virtual and no real money is traded. Nothing on this
          site is investment advice. Trading real financial instruments involves a high risk of loss. Market data from Coinbase,
          CoinGecko and the European Central Bank{isDemo ? "; this public demo runs entirely in your browser" : ""}. © {new Date().getFullYear()} AUREX AI.
        </p>
      </div>
    </footer>
  );
}

export function SiteLayout() {
  return (
    <div className="flex min-h-full flex-col">
      <MaintenanceBanner />
      <SiteHeader />
      <main className="flex-1"><Outlet /></main>
      <SiteFooter />
    </div>
  );
}
