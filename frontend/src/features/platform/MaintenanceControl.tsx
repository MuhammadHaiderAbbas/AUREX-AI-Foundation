import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Wrench } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ErrorBanner } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/form";
import { useSystemInfo } from "@/features/accounts/hooks";
import { formatDateTime } from "@/lib/utils";
import { api, type SystemInfo } from "@/services/api";

/** Admin: put the whole website on hold. Traders cannot sign in or use the app; administrators can. */
export function MaintenanceControl() {
  const qc = useQueryClient();
  const info = useSystemInfo();
  const m = info.data?.maintenance;
  const [message, setMessage] = useState("");
  const [until, setUntil] = useState("");
  const set = useMutation({
    mutationFn: (enabled: boolean) => api<NonNullable<SystemInfo["maintenance"]>>("/admin/maintenance", {
      method: "POST", json: { enabled, message: message.trim() || null, until: until ? new Date(until).toISOString() : null } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["system-info"] }); setMessage(""); setUntil(""); },
  });
  return (
    <Card data-testid="maintenance-control">
      <CardHeader title={<span className="flex items-center gap-2"><Wrench className="size-4" />Maintenance mode (site on hold)</span>}
        description="Traders see a maintenance notice and cannot sign in or use the app; administrators keep access. AI bots and autopilot pause; protective stops and limit orders keep working."
        action={m?.enabled ? <Badge tone="warning">On hold</Badge> : <Badge tone="positive">Online</Badge>} />
      <CardBody className="space-y-4">
        <ErrorBanner error={set.error} />
        {m?.enabled ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-warning/10 p-4">
            <div className="text-sm">
              <div className="font-medium text-warning">The site is on hold{m.since ? ` since ${formatDateTime(m.since)}` : ""}.</div>
              <div className="mt-0.5 text-muted">{m.message || "Default maintenance message"}{m.until ? ` · back ${formatDateTime(m.until)}` : ""}</div>
            </div>
            <Button onClick={() => set.mutate(false)} disabled={set.isPending}>Bring the site back online</Button>
          </div>
        ) : (
          <form className="grid gap-4 md:grid-cols-[1fr_220px_auto] md:items-end" onSubmit={(e) => { e.preventDefault(); set.mutate(true); }}>
            <Field label="Message for traders (optional)" htmlFor="mnt-msg">
              <Input id="mnt-msg" maxLength={300} placeholder="We're upgrading the platform." value={message} onChange={(e) => setMessage(e.target.value)} />
            </Field>
            <Field label="Expected back (optional)" htmlFor="mnt-until">
              <Input id="mnt-until" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
            </Field>
            <Button type="submit" variant="danger" disabled={set.isPending}>Put the site on hold</Button>
          </form>
        )}
      </CardBody>
    </Card>
  );
}
