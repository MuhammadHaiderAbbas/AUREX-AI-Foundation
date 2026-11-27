import { Wrench } from "lucide-react";
import { Link } from "react-router-dom";
import { useSystemInfo } from "@/features/accounts/hooks";
import { formatDateTime } from "@/lib/utils";

export function useMaintenance() {
  const info = useSystemInfo();
  const m = info.data?.maintenance;
  return m?.enabled ? m : null;
}

/** Thin banner on the public site while the platform is on hold. */
export function MaintenanceBanner() {
  const m = useMaintenance();
  if (!m) return null;
  return (
    <div role="status" className="bg-warning/15 px-4 py-2 text-center text-sm text-warning">
      <Wrench className="mr-1.5 inline size-4" />
      {m.message || "AUREX is temporarily on hold for maintenance."}
      {m.until && <> Expected back {formatDateTime(m.until)}.</>}
    </div>
  );
}

/** Full-page notice shown to traders instead of the app while the platform is on hold. */
export function MaintenancePage() {
  const m = useMaintenance();
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="max-w-md text-center" data-testid="maintenance-page">
        <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-warning/15 text-warning"><Wrench className="size-7" /></div>
        <h1 className="mt-5 text-2xl font-semibold">We'll be right back</h1>
        <p className="mt-2 text-muted">{m?.message || "AUREX is temporarily on hold for maintenance. Your paper accounts and positions are safe."}</p>
        {m?.until && <p className="mt-1 text-sm text-subtle">Expected back {formatDateTime(m.until)}.</p>}
        <Link to="/" className="mt-6 inline-block text-sm text-accent hover:underline">Back to the home page</Link>
      </div>
    </div>
  );
}
