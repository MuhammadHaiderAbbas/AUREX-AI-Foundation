import { LogOut, Menu, X } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Brand } from "@/components/site/Brand";
import { StatusDot } from "@/components/ui/badge";
import { useAuth } from "@/features/auth/AuthProvider";
import { useMaintenance } from "@/features/platform/Maintenance";
import { useSystemHalt } from "@/features/risk/hooks";
import { admin } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { isDemo } from "@/services/api";
import { ADMIN_NAV } from "./nav";

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Admin" className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {ADMIN_NAV.map((g) => (
        <div key={g.group}>
          <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">{g.group}</div>
          {g.items.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end} onClick={onNavigate}
              className={({ isActive }) => cn("flex items-center gap-3 rounded-lg px-3 py-2 text-sm", isActive ? "bg-surface-3 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg")}>
              <i.icon className="size-4 shrink-0" />{i.label}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

/** The admin console: platform management, separate from the trading app (administrators do not trade). */
export function AdminShell() {
  const { user, logout } = useAuth();
  const halt = useSystemHalt();
  const maintenance = useMaintenance();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const current = ADMIN_NAV.flatMap((g) => g.items).find((i) => (i.end ? location.pathname === i.to : location.pathname.startsWith(i.to)));
  const side = (
    <>
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div><Brand to={admin()} /><div className="mt-1 text-[11px] font-medium uppercase tracking-wider text-accent">Admin console</div></div>
        <button className="text-muted lg:hidden" onClick={() => setOpen(false)} aria-label="Close menu"><X className="size-5" /></button>
      </div>
      <Sidebar onNavigate={() => setOpen(false)} />
      <div className="border-t border-border p-4">
        <div className="text-sm font-medium">{user?.full_name}</div>
        <div className="truncate text-xs text-subtle">{user?.email}</div>
        <button onClick={() => void logout()} className="mt-3 flex items-center gap-2 text-sm text-muted hover:text-fg"><LogOut className="size-4" />Log out</button>
      </div>
    </>
  );
  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface lg:flex">{side}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-border bg-surface">{side}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 lg:px-6">
          <button className="text-muted lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="size-5" /></button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">{current?.label ?? "Admin console"}</h1>
            <p className="hidden truncate text-xs text-muted sm:block">{current?.description}</p>
          </div>
          {maintenance && <span className="flex items-center gap-1.5 rounded-md bg-warning/15 px-2 py-1 text-xs font-medium text-warning"><StatusDot tone="warning" />Site on hold</span>}
          {halt.data?.halted
            ? <span className="flex items-center gap-1.5 rounded-md bg-negative/15 px-2 py-1 text-xs font-medium text-negative"><StatusDot tone="negative" />Trading halted</span>
            : <span className="hidden items-center gap-1.5 text-xs text-muted sm:flex"><StatusDot tone="positive" />Risk gate on</span>}
          {isDemo && <span className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted">Demo</span>}
        </header>
        <main className="flex-1 overflow-y-auto"><div className="mx-auto max-w-[1400px] p-4 lg:p-6"><Outlet /></div></main>
      </div>
    </div>
  );
}
