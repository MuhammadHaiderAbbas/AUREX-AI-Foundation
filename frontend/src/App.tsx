import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AdminShell } from "@/components/layout/AdminShell";
import { AppShell } from "@/components/layout/AppShell";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Spinner } from "@/components/ui/feedback";
import { useAuth } from "@/features/auth/AuthProvider";
import { MaintenancePage, useMaintenance } from "@/features/platform/Maintenance";
import { ADMIN, APP, app } from "@/lib/paths";
import { AdminControlsPage } from "@/pages/AdminControlsPage";
import { AdminPage } from "@/pages/AdminPage";
import { AdminResearchPage } from "@/pages/AdminResearchPage";
import { AgentConfig, AITradingPage } from "@/pages/AITradingPage";
import { AnalyticsPage } from "@/pages/AnalyticsPage";
import { AdminLoginPage, LoginPage, RegisterPage } from "@/pages/AuthPages";
import { BacktestPage } from "@/pages/BacktestPage";
import { BinaryPage } from "@/pages/BinaryPage";
import { FuturesPage } from "@/pages/FuturesPage";
import { HistoryPage } from "@/pages/HistoryPage";
import { MarketsPage } from "@/pages/MarketsPage";
import { ModelLabPage } from "@/pages/ModelLabPage";
import { OperationsPage } from "@/pages/OperationsPage";
import { OverviewPage } from "@/pages/OverviewPage";
import { PortfolioPage } from "@/pages/PortfolioPage";
import { ResearchPage } from "@/pages/ResearchPage";
import { RiskPage } from "@/pages/RiskPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { WalletPage } from "@/pages/WalletPage";
import { HomePage } from "@/pages/site/HomePage";
import { AboutPage, AiTradingInfoPage, LegalPage, SecurityPage } from "@/pages/site/InfoPages";
import { MarketsPublicPage } from "@/pages/site/MarketsPublicPage";

const Loading = () => <div className="flex h-full items-center justify-center"><Spinner className="size-6" /></div>;

/** Traders only: administrators manage the platform from the admin console and do not trade. */
function RequireTrader({ children }: { children: React.ReactNode }) {
  const { status, user } = useAuth();
  const maintenance = useMaintenance();
  if (status === "loading") return <Loading />;
  if (status === "anonymous") return <Navigate to="/login" replace />;
  if (user?.role === "admin") return <Navigate to={ADMIN} replace />;
  if (maintenance) return <MaintenancePage />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { status, user } = useAuth();
  if (status === "loading") return <Loading />;
  if (status === "anonymous") return <Navigate to={`${ADMIN}/login`} replace />;
  if (user?.role !== "admin") return <Navigate to={APP} replace />;
  return <>{children}</>;
}

/** Links from before the /app move (bookmarks, shared links) land on the same screen. */
const LEGACY: Record<string, string> = {
  "/strategies": "/", "/portfolio": "/portfolio", "/history": "/history", "/risk": "/risk", "/analytics": "/analytics",
  "/wallet": "/wallet", "/settings": "/settings/profile", "/backtests": "/backtests", "/binary": "/binary", "/research": "/research",
};
function Legacy({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={app(to) + search} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route element={<SiteLayout />}>
        <Route index element={<HomePage />} />
        <Route path="markets" element={<MarketsPublicPage />} />
        <Route path="ai-trading" element={<AiTradingInfoPage />} />
        <Route path="security" element={<SecurityPage />} />
        <Route path="about" element={<AboutPage />} />
        <Route path="legal/:doc" element={<LegalPage />} />
      </Route>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path={`${ADMIN}/login`} element={<AdminLoginPage />} />

      <Route path={APP} element={<RequireTrader><AppShell /></RequireTrader>}>
        <Route index element={<OverviewPage />} />
        <Route path="trade" element={<MarketsPage />} />
        <Route path="ai" element={<AITradingPage />} />
        <Route path="research" element={<ResearchPage />} />
        <Route path="portfolio" element={<PortfolioPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="wallet" element={<WalletPage />} />
        <Route path="risk" element={<RiskPage />} />
        <Route path="backtests" element={<BacktestPage />} />
        <Route path="binary" element={<BinaryPage />} />
        <Route path="futures" element={<FuturesPage />} />
        <Route path="settings" element={<Navigate to={app("/settings/profile")} replace />} />
        <Route path="settings/:section" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to={APP} replace />} />
      </Route>

      <Route path={ADMIN} element={<RequireAdmin><AdminShell /></RequireAdmin>}>
        <Route index element={<OperationsPage />} />
        <Route path="controls" element={<AdminControlsPage />} />
        <Route path="users" element={<AdminPage />} />
        <Route path="models" element={<ModelLabPage />} />
        <Route path="agents" element={<AgentConfig />} />
        <Route path="research" element={<AdminResearchPage />} />
        <Route path="*" element={<Navigate to={ADMIN} replace />} />
      </Route>

      {Object.entries(LEGACY).map(([from, to]) => <Route key={from} path={from} element={<Legacy to={to} />} />)}
      <Route path="/operations" element={<Navigate to={ADMIN} replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
