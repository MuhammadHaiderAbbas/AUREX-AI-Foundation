import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { useAuth } from "@/features/auth/AuthProvider";
import { api, type UserSettings } from "@/services/api";

const TIMEZONES = ["Europe/London", "Europe/Paris", "America/New_York", "America/Chicago", "Asia/Tokyo", "Asia/Singapore", "UTC"];

function Preferences() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<UserSettings>("/users/me/settings") });
  const [form, setForm] = useState({ timezone: "Europe/London", base_currency: "USD" });
  useEffect(() => { if (settings.data) setForm({ timezone: settings.data.timezone, base_currency: settings.data.base_currency }); }, [settings.data]);
  const save = useMutation({
    mutationFn: () => api<UserSettings>("/users/me/settings", { method: "PATCH", json: form }),
    onSuccess: (d) => qc.setQueryData(["settings"], d),
  });
  return (
    <Card>
      <CardHeader title="Preferences" />
      <CardBody>
        {settings.isLoading ? <Spinner /> : (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <ErrorBanner error={save.error} />
            <Field label="Timezone" htmlFor="tz">
              <Select id="tz" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
                {[...new Set([form.timezone, ...TIMEZONES])].map((t) => <option key={t}>{t}</option>)}
              </Select>
            </Field>
            <Field label="Reporting currency" htmlFor="ccy">
              <Select id="ccy" value={form.base_currency} onChange={(e) => setForm({ ...form, base_currency: e.target.value })}>
                {["USD", "GBP", "EUR"].map((c) => <option key={c}>{c}</option>)}
              </Select>
            </Field>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={save.isPending}>Save preferences</Button>
              {save.isSuccess && <span className="flex items-center gap-1 text-xs text-positive"><CheckCircle2 className="size-3.5" />Saved</span>}
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = useMutation({
    mutationFn: () => api("/auth/password", { method: "POST", json: { current_password: current, new_password: next } }),
    onSuccess: () => { setCurrent(""); setNext(""); },
  });
  return (
    <Card>
      <CardHeader title="Change password" description="Signs out all other sessions" />
      <CardBody>
        <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); change.mutate(); }}>
          <ErrorBanner error={change.error} />
          <Field label="Current password" htmlFor="cur"><Input id="cur" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
          <Field label="New password" htmlFor="new"><Input id="new" type="password" autoComplete="new-password" required minLength={12} value={next} onChange={(e) => setNext(e.target.value)} /></Field>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={change.isPending}>Update password</Button>
            {change.isSuccess && <span className="flex items-center gap-1 text-xs text-positive"><CheckCircle2 className="size-3.5" />Password updated</span>}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

export function SettingsPage() {
  const { user } = useAuth();
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader title="Profile" />
        <CardBody className="grid gap-4 text-sm sm:grid-cols-3">
          <div><div className="text-xs text-muted">Name</div>{user?.full_name}</div>
          <div><div className="text-xs text-muted">Email</div>{user?.email}</div>
          <div><div className="text-xs text-muted">Role</div><span className="capitalize">{user?.role}</span></div>
        </CardBody>
      </Card>
      <Preferences />
      <ChangePassword />
      <Card className="lg:col-span-2">
        <CardHeader title="Brokers & data providers" description="Integrations arrive in Phase 3 (data) and Phase 12 (broker sandboxes)" />
        <CardBody className="text-sm text-muted">
          No external connections are configured. Live trading is disabled at both the application and database level during Stage 1.
        </CardBody>
      </Card>
    </div>
  );
}
