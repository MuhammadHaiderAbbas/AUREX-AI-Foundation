import {
  BarChart3, Bot, Gauge, BrainCircuit, CandlestickChart, FlaskConical, History, LayoutDashboard, Library, PieChart, PauseCircle,
  Server, ShieldAlert, ShieldCheck, SlidersHorizontal, Timer, Users, Wallet, Workflow, type LucideIcon,
} from "lucide-react";
import { admin, app } from "@/lib/paths";

export interface NavItem { to: string; label: string; description: string; icon: LucideIcon; end?: boolean }

/** Trading app: primary items in the top bar, the rest under "More". */
export const APP_NAV: NavItem[] = [
  { to: app(), end: true, label: "Dashboard", description: "Your accounts, equity and activity", icon: LayoutDashboard },
  { to: app("/trade"), label: "Trade", description: "Charts, order book and orders", icon: CandlestickChart },
  { to: app("/futures"), label: "Futures", description: "Leveraged crypto perpetuals with a real order book", icon: Gauge },
  { to: app("/ai"), label: "AI Desk", description: "Agent analysis, proposals and autopilot", icon: Bot },
  { to: app("/research"), label: "Research", description: "Ask questions about the research library", icon: BrainCircuit },
  { to: app("/portfolio"), label: "Portfolio", description: "Positions and closed trades", icon: PieChart },
  { to: app("/analytics"), label: "Analytics", description: "Performance and reports", icon: BarChart3 },
];
export const APP_MORE: NavItem[] = [
  { to: app("/history"), label: "Orders & history", description: "Orders, executions and decisions", icon: History },
  { to: app("/wallet"), label: "Wallet", description: "Virtual deposits and the ledger", icon: Wallet },
  { to: app("/risk"), label: "Risk limits", description: "Your safety limits and circuit breakers", icon: ShieldAlert },
  { to: app("/backtests"), label: "Backtesting", description: "Test strategies on history", icon: FlaskConical },
  { to: app("/binary"), label: "Binary options", description: "Paper HIGHER/LOWER contracts and the AI bot", icon: Timer },
];

/** Admin console: platform management only, no trading. */
export const ADMIN_NAV: { group: string; items: NavItem[] }[] = [
  { group: "Platform", items: [
    { to: admin(), end: true, label: "Overview", description: "Platform health, backups and go-live gates", icon: Server },
    { to: admin("/controls"), label: "Trading controls", description: "Kill switch and maintenance (site on hold)", icon: PauseCircle },
  ] },
  { group: "People", items: [
    { to: admin("/users"), label: "Users & audit", description: "Accounts, roles and the tamper-evident audit trail", icon: Users },
  ] },
  { group: "AI", items: [
    { to: admin("/models"), label: "Model Lab", description: "Train, validate, promote and retire models", icon: Workflow },
    { to: admin("/agents"), label: "Agents", description: "Agent weights and availability", icon: SlidersHorizontal },
    { to: admin("/research"), label: "Research library", description: "Documents the Research Lab and agents read", icon: Library },
  ] },
];

export const ALL_NAV = [...APP_NAV, ...APP_MORE, ...ADMIN_NAV.flatMap((g) => g.items)];
export const ADMIN_ICON = ShieldCheck;
