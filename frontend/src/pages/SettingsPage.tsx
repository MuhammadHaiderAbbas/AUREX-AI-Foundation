import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Plus, ShieldCheck, UserRound, Wallet } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, NavLink, useParams } from "react-router-dom";
import { CreateAccountDialog } from "@/features/accounts/CreateAccountDialog";
import { app } from "@/lib/paths";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { useAccounts, useRevokeSession, useSessions } from "@/features/accounts/hooks";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";
import { useAuth } from "@/features/auth/AuthProvider";
import { api, type User, type UserSettings } from "@/services/api";

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

function TwoFactor() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<User>("/auth/me") });
  const [stage, setStage] = useState<"idle" | "password" | "scan" | "codes" | "disable" | "regenerate">("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const reset = () => { setPassword(""); setCode(""); };
  const done = () => { qc.invalidateQueries({ queryKey: ["me"] }); qc.invalidateQueries({ queryKey: ["sessions"] }); qc.invalidateQueries({ queryKey: ["activity"] }); };
  const start = useMutation({ mutationFn: () => api<{ secret: string; otpauth_uri: string }>("/auth/mfa/setup", { method: "POST", json: { password } }),
    onSuccess: (r) => { setSetup(r); reset(); setStage("scan"); } });
  const enable = useMutation({ mutationFn: () => api<{ recovery_codes: string[] }>("/auth/mfa/enable", { method: "POST", json: { code } }),
    onSuccess: (r) => { setCodes(r.recovery_codes); setSetup(null); reset(); setStage("codes"); done(); } });
  const disable = useMutation({ mutationFn: () => api<null>("/auth/mfa/disable", { method: "POST", json: { password, code } }),
    onSuccess: () => { reset(); setStage("idle"); done(); } });
  const regenerate = useMutation({ mutationFn: () => api<{ recovery_codes: string[] }>("/auth/mfa/recovery-codes", { method: "POST", json: { password, code } }),
    onSuccess: (r) => { setCodes(r.recovery_codes); reset(); setStage("codes"); done(); } });
  const on = me.data?.mfa_enabled;
  const err = start.error ?? enable.error ?? disable.error ?? regenerate.error;
  const download = () => {
    const blob = new Blob([`AUREX AI recovery codes for ${me.data?.email}\nEach code works once.\n\n${codes.join("\n")}\n`], { type: "text/plain" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "aurex-recovery-codes.txt"; a.click(); URL.revokeObjectURL(a.href);
  };
  const pwCode = (label: string, run: () => void, pending: boolean, variant: "primary" | "danger") => (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run(); }}>
      <Field label="Password" htmlFor="tf-pw"><Input id="tf-pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <Field label="Authentication or recovery code" htmlFor="tf-code"><Input id="tf-code" autoComplete="one-time-code" required className="num" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
      <div className="flex gap-2"><Button type="submit" size="sm" variant={variant} disabled={pending}>{label}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => { reset(); setStage("idle"); }}>Cancel</Button></div>
    </form>
  );
  return (
    <Card data-testid="two-factor">
      <CardHeader title="Two-factor authentication" description="A code from an authenticator app is required at every sign-in."
        action={<Badge tone={on ? "positive" : "warning"}>{on ? "On" : "Off"}</Badge>} />
      <CardBody className="space-y-4 text-sm">
        <ErrorBanner error={err} />
        {stage === "idle" && (on ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setStage("regenerate")}>New recovery codes</Button>
            <Button size="sm" variant="danger" onClick={() => setStage("disable")}>Turn off</Button>
          </div>
        ) : <Button size="sm" onClick={() => setStage("password")}>Set up two-factor authentication</Button>)}
        {stage === "password" && (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
            <Field label="Confirm your password" htmlFor="tf-pw0"><Input id="tf-pw0" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            <div className="flex gap-2"><Button type="submit" size="sm" disabled={start.isPending}>Continue</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => { reset(); setStage("idle"); }}>Cancel</Button></div>
          </form>
        )}
        {stage === "scan" && setup && (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); enable.mutate(); }}>
            <p className="text-muted">Add this key to your authenticator app (Google Authenticator, 1Password, Authy…), then enter the 6-digit code it shows.</p>
            <div className="rounded-md border border-border bg-surface-2 p-3">
              <div className="text-[11px] uppercase tracking-wider text-subtle">Setup key</div>
              <div className="num mt-1 break-all text-base tracking-wider" data-testid="mfa-secret">{setup.secret.match(/.{1,4}/g)!.join(" ")}</div>
              <a href={setup.otpauth_uri} className="mt-2 inline-block text-xs text-accent hover:underline">Open in an authenticator app on this device</a>
            </div>
            <Field label="6-digit code" htmlFor="tf-first"><Input id="tf-first" autoComplete="one-time-code" inputMode="numeric" required maxLength={6} className="num tracking-widest" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            <div className="flex gap-2"><Button type="submit" size="sm" disabled={enable.isPending || code.length !== 6}>Turn on</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => { setSetup(null); reset(); setStage("idle"); }}>Cancel</Button></div>
          </form>
        )}
        {stage === "codes" && (
          <div className="space-y-3" data-testid="recovery-codes">
            <p className="text-warning">Save these recovery codes somewhere safe. Each works once if you lose your device. They will not be shown again.</p>
            <ul className="num grid grid-cols-2 gap-1 rounded-md border border-border bg-surface-2 p-3 text-sm">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
            <div className="flex gap-2"><Button size="sm" variant="secondary" onClick={download}>Download</Button>
              <Button size="sm" onClick={() => { setCodes([]); setStage("idle"); }}>I have saved them</Button></div>
          </div>
        )}
        {stage === "disable" && pwCode("Turn off two-factor authentication", () => disable.mutate(), disable.isPending, "danger")}
        {stage === "regenerate" && pwCode("Generate new codes", () => regenerate.mutate(), regenerate.isPending, "primary")}
      </CardBody>
    </Card>
  );
}

/** Coarse, human-readable device label from a user agent (display only). */
function device(ua: string | null) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function Sessions() {
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const others = (sessions.data ?? []).filter((x) => !x.current).length;
  return (
    <Card className="lg:col-span-2" data-testid="sessions">
      <CardHeader title="Signed-in sessions" description="Each browser or device you signed in from. Revoking one signs it out immediately."
        action={others > 0 && <Button size="sm" variant="danger" onClick={() => revoke.mutate("others")} disabled={revoke.isPending}>Sign out {others} other{others === 1 ? "" : "s"}</Button>} />
      <ErrorBanner error={sessions.error ?? revoke.error} className="m-4" />
      {sessions.isLoading ? <div className="p-6"><Spinner className="mx-auto" /></div> : (
        <Table>
          <thead><tr><Th>Device</Th><Th>Address</Th><Th>Signed in</Th><Th>Last active</Th><Th /></tr></thead>
          <tbody>
            {sessions.data?.map((x) => (
              <Tr key={x.id}>
                <Td title={x.user_agent ?? undefined}>{device(x.user_agent)} {x.current && <Badge tone="positive" className="ml-1">This session</Badge>}</Td>
                <Td className="num text-xs text-muted">{x.ip_address ?? "—"}</Td>
                <Td className="num text-xs text-muted">{formatDateTime(x.signed_in_at)}</Td>
                <Td className="text-xs text-muted">{relativeTime(x.last_active_at)}</Td>
                <Td className="text-right">{!x.current && <Button size="sm" variant="ghost" onClick={() => revoke.mutate(x.id)} disabled={revoke.isPending} aria-label={`Revoke ${device(x.user_agent)} session`}>Revoke</Button>}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Profile() {
  const { user } = useAuth();
  return (
    <Card>
      <CardHeader title="Profile" description="Your identity on AUREX" />
      <CardBody className="flex flex-wrap items-center gap-5">
        <span className="flex size-14 items-center justify-center rounded-full bg-accent/20 text-lg font-semibold text-accent">
          {(user?.full_name ?? "?").split(/\s+/).map((x) => x[0]).slice(0, 2).join("").toUpperCase()}
        </span>
        <dl className="grid flex-1 gap-4 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-muted">Name</dt><dd className="mt-0.5 font-medium">{user?.full_name}</dd></div>
          <div><dt className="text-xs text-muted">Email</dt><dd className="mt-0.5 font-medium">{user?.email}</dd></div>
          <div><dt className="text-xs text-muted">Member since</dt><dd className="mt-0.5 font-medium">{user?.created_at ? formatDateTime(user.created_at) : "—"}</dd></div>
        </dl>
      </CardBody>
    </Card>
  );
}

function Activity() {
  const activity = useQuery({ queryKey: ["my-activity"], queryFn: () => api<{ id: number; action: string; outcome: string; created_at: string; ip_address: string | null }[]>("/users/me/activity?limit=15") });
  return (
    <Card>
      <CardHeader title="Recent activity" description="Sign-ins and changes on your account" />
      {activity.isLoading ? <CardBody><Spinner /></CardBody> : (
        <Table>
          <thead><tr><Th>When</Th><Th>Action</Th><Th>Result</Th></tr></thead>
          <tbody>
            {(activity.data ?? []).map((a) => (
              <Tr key={a.id}><Td className="whitespace-nowrap text-xs text-muted">{relativeTime(a.created_at)}</Td><Td className="text-sm">{a.action}</Td>
                <Td><Badge tone={a.outcome === "success" ? "positive" : "negative"}>{a.outcome}</Badge></Td></Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Accounts() {
  const accounts = useAccounts();
  const [creating, setCreating] = useState(false);
  return (
    <Card>
      <CardHeader title="Paper accounts" description="Each account has its own balance, positions, limits and AI settings"
        action={<Button size="sm" onClick={() => setCreating(true)}><Plus />New account</Button>} />
      {accounts.isLoading ? <CardBody><Spinner /></CardBody> : (
        <Table>
          <thead><tr><Th>Name</Th><Th>Currency</Th><Th>Mode</Th><Th>Status</Th><Th /></tr></thead>
          <tbody>
            {(accounts.data ?? []).map((a) => (
              <Tr key={a.id}>
                <Td className="font-medium">{a.name}</Td><Td>{a.base_currency}</Td><Td><Badge>{a.mode}</Badge></Td>
                <Td><Badge tone={a.status === "ACTIVE" ? "positive" : "neutral"}>{a.status}</Badge></Td>
                <Td className="text-right"><Link to={app(`/wallet?account=${a.id}`)} className="text-sm text-accent hover:underline">Wallet</Link></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <CreateAccountDialog open={creating} onClose={() => setCreating(false)} />
    </Card>
  );
}

const SECTIONS = [
  { key: "profile", label: "Profile", icon: UserRound },
  { key: "security", label: "Security", icon: ShieldCheck },
  { key: "accounts", label: "Paper accounts", icon: Wallet },
] as const;

export function SettingsPage() {
  const { section = "profile" } = useParams();
  if (!SECTIONS.some((x) => x.key === section)) return <Navigate to={app("/settings/profile")} replace />;
  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <aside>
        <h1 className="mb-4 text-xl font-semibold">Settings</h1>
        <nav aria-label="Settings" className="flex gap-1 overflow-x-auto lg:flex-col">
          {SECTIONS.map((x) => (
            <NavLink key={x.key} to={app(`/settings/${x.key}`)}
              className={({ isActive }) => cn("flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm", isActive ? "bg-surface-2 text-fg" : "text-muted hover:text-fg")}>
              <x.icon className="size-4" />{x.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 space-y-6">
        {section === "profile" && <><Profile /><Preferences /><Activity /></>}
        {section === "security" && <><ChangePassword /><TwoFactor /><Sessions /></>}
        {section === "accounts" && <Accounts />}
      </div>
    </div>
  );
}
