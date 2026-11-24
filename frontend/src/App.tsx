import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { NAV } from "@/components/layout/nav";
import { Spinner } from "@/components/ui/feedback";
import { useAuth } from "@/features/auth/AuthProvider";
import { AdminPage } from "@/pages/AdminPage";
import { AITradingPage } from "@/pages/AITradingPage";
import { BacktestPage } from "@/pages/BacktestPage";
import { BinaryPage } from "@/pages/BinaryPage";
import { LoginPage, RegisterPage } from "@/pages/AuthPages";
import { MarketsPage } from "@/pages/MarketsPage";
import { ModelLabPage } from "@/pages/ModelLabPage";
import { ModulePage } from "@/pages/ModulePage";
import { OverviewPage } from "@/pages/OverviewPage";
import { ResearchPage } from "@/pages/ResearchPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { WalletPage } from "@/pages/WalletPage";
import { PortfolioPage } from "@/pages/PortfolioPage";
import { HistoryPage } from "@/pages/HistoryPage";
import { RiskPage } from "@/pages/RiskPage";
import { AnalyticsPage } from "@/pages/AnalyticsPage";
import { OperationsPage } from "@/pages/OperationsPage";

function RequireAuth({ children, admin = false }: { children: React.ReactNode; admin?: boolean }) {
  const { status, user } = useAuth();
  if (status === "loading") return <div className="flex h-full items-center justify-center"><Spinner className="size-6" /></div>;
  if (status === "anonymous") return <Navigate to="/login" replace />;
  if (admin && user?.role !== "admin") return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={<OverviewPage />} />
        <Route path="markets" element={<MarketsPage />} />
        <Route path="research" element={<ResearchPage />} />
        <Route path="ai-trading" element={<AITradingPage />} />
        <Route path="strategies" element={<ModelLabPage />} />
        <Route path="backtests" element={<BacktestPage />} />
        <Route path="binary" element={<BinaryPage />} />
        <Route path="portfolio" element={<PortfolioPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="risk" element={<RiskPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="wallet" element={<WalletPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="admin" element={<RequireAuth admin><AdminPage /></RequireAuth>} />
        <Route path="operations" element={<RequireAuth admin><OperationsPage /></RequireAuth>} />
        {NAV.filter((n) => n.phase).map((n) => (
          <Route key={n.to} path={n.to.slice(1)} element={<ModulePage item={n} />} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
