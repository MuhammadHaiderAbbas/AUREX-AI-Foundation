import {
  BarChart3, Bot, BrainCircuit, CandlestickChart, History, LayoutDashboard,
  Settings, ShieldAlert, ShieldCheck, Wallet, Workflow, type LucideIcon, PieChart,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  description: string;
  icon: LucideIcon;
  phase?: number; // module delivered in a later phase
  adminOnly?: boolean;
}

export const NAV: NavItem[] = [
  { to: "/", label: "Overview", description: "Market and portfolio overview", icon: LayoutDashboard },
  { to: "/markets", label: "Markets", description: "Crypto, Forex, Stocks and ETFs", icon: CandlestickChart },
  { to: "/ai-trading", label: "AI Trading", description: "Autonomous trading controls", icon: Bot, phase: 8 },
  { to: "/research", label: "AI Research Lab", description: "Agents and research reports", icon: BrainCircuit, phase: 4 },
  { to: "/strategies", label: "Strategies", description: "Model and strategy management", icon: Workflow, phase: 7 },
  { to: "/portfolio", label: "Portfolio", description: "Positions and performance", icon: PieChart, phase: 8 },
  { to: "/risk", label: "Risk Centre", description: "Exposure and safety limits", icon: ShieldAlert, phase: 9 },
  { to: "/wallet", label: "Wallet", description: "Virtual account and ledger", icon: Wallet },
  { to: "/history", label: "Trade History", description: "Orders, executions and decisions", icon: History, phase: 8 },
  { to: "/analytics", label: "Analytics", description: "Performance and reports", icon: BarChart3, phase: 10 },
  { to: "/settings", label: "Settings", description: "Accounts and configurations", icon: Settings },
  { to: "/admin", label: "Administration", description: "Users and audit trail", icon: ShieldCheck, adminOnly: true },
];

