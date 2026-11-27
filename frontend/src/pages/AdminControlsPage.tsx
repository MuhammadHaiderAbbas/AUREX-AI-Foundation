import { TradingHalt } from "@/pages/AdminPage";
import { MaintenanceControl } from "@/features/platform/MaintenanceControl";

export function AdminControlsPage() {
  return <div className="space-y-6"><TradingHalt /><MaintenanceControl /></div>;
}
