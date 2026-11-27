import { CheckCircle2, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { Brand } from "@/components/site/Brand";
import { Button } from "@/components/ui/button";
import { ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/form";
import { useAuth } from "@/features/auth/AuthProvider";
import { MaintenanceBanner } from "@/features/platform/Maintenance";
import { homeFor } from "@/lib/paths";
import { api, ApiError, isDemo, type TradingAccount } from "@/services/api";

function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <MaintenanceBanner />
      <div className="grid flex-1 lg:grid-cols-[1fr_560px]">
        <section className="bg-grid relative hidden overflow-hidden border-r border-border lg:flex lg:flex-col lg:justify-between lg:p-12">
          <div className="pointer-events-none absolute -top-32 -left-32 size-[520px] rounded-full bg-accent/15 blur-3xl" />
          <Brand className="relative" />
          <div className="relative max-w-lg">
            <h2 className="text-4xl font-semibold leading-tight tracking-tight">Trade with an AI desk that <span className="text-accent">shows its work.</span></h2>
            <ul className="mt-6 space-y-3 text-muted">
              {["Eight AI specialists explain every decision", "An independent risk engine checks every order", "Live crypto and forex prices, £100 of virtual money"].map((t) => (
                <li key={t} className="flex items-center gap-3"><CheckCircle2 className="size-5 text-positive" />{t}</li>
              ))}
            </ul>
          </div>
          <div className="relative flex items-center gap-2 text-xs text-subtle">
            <ShieldCheck className="size-4 text-accent" /> Paper trading with virtual money only. No real money is moved.
          </div>
        </section>
        <section className="flex items-center justify-center p-6">
          <div className="w-full max-w-sm">
            <Brand className="mb-10 lg:hidden" />
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-1.5 text-sm text-muted">{subtitle}</p>
            {isDemo && (
              <div className="mt-5 rounded-lg border border-info/30 bg-info/10 px-3 py-2.5 text-xs leading-relaxed text-info">
                <strong>Public demo.</strong> Everything runs in your browser and is stored only on this device. Prices for crypto and forex are live.
              </div>
            )}
            <div className="mt-6">{children}</div>
            <p className="mt-8 text-center text-xs text-subtle"><Link to="/" className="hover:text-fg">← Back to the home page</Link></p>
          </div>
        </section>
      </div>
    </div>
  );
}

function SecondFactor({ mfaToken, onCancel }: { mfaToken: string; onCancel: () => void }) {
  const { verifyMfa } = useAuth();
  const [code, setCode] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await verifyMfa(mfaToken, code.trim()); }
    catch (err) { setError(err); setCode(""); }
    finally { setBusy(false); }
  }
  return (
    <AuthLayout title="Two-factor authentication" subtitle="Enter the 6-digit code from your authenticator app, or one of your recovery codes.">
      <form onSubmit={submit} className="space-y-4" aria-label="Second factor">
        <ErrorBanner error={error} />
        <Field label="Authentication code" htmlFor="mfa-code">
          <Input id="mfa-code" autoComplete="one-time-code" inputMode="text" autoFocus required maxLength={32} className="num tracking-widest"
            value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" disabled={busy || code.trim().length < 6}>{busy && <Spinner className="text-accent-fg" />}Verify</Button>
        <button type="button" onClick={onCancel} className="w-full text-center text-xs text-muted hover:text-fg">Use a different account</button>
      </form>
    </AuthLayout>
  );
}

export function LoginPage() {
  const { login, status, user } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  if (status === "authenticated" && !launching) return <Navigate to={homeFor(user?.role)} replace />;
  if (mfaToken) return <SecondFactor mfaToken={mfaToken} onCancel={() => { setMfaToken(null); setPassword(""); }} />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const challenge = await login(email, password);
      if (challenge) setMfaToken(challenge.mfaToken);
    }
    catch (err) { setError(err); }
    finally { setBusy(false); }
  }

  return (
    <AuthLayout title="Log in" subtitle="Welcome back to your AUREX trading terminal.">
      <form onSubmit={submit} className="space-y-4">
        <ErrorBanner error={error} />
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" disabled={busy}>{busy && <Spinner className="text-accent-fg" />}Log in</Button>
        {isDemo && (
          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-center text-xs text-subtle">Or explore without signing up</p>
            <DemoLaunch onError={setError} onChallenge={setMfaToken} onBusy={setLaunching} />
            <DemoLaunch large onError={setError} onChallenge={setMfaToken} onBusy={setLaunching} />
            <DemoLaunch admin onError={setError} onChallenge={setMfaToken} onBusy={setLaunching} />
          </div>
        )}
        <p className="text-center text-sm text-muted">New to AUREX? <Link to="/register" className="font-medium text-accent hover:underline">Create an account</Link></p>
      </form>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { register, login, status, user } = useAuth();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (status === "authenticated" && !busy) return <Navigate to={homeFor(user?.role)} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await register(form.email, form.name, form.password);
      await login(form.email, form.password);
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <AuthLayout title="Create your account" subtitle="Free paper-trading account. No card, no real money.">
      <form onSubmit={submit} className="space-y-4">
        <ErrorBanner error={error} />
        <Field label="Full name" htmlFor="name">
          <Input id="name" autoComplete="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 12 characters using three of: lowercase, uppercase, digits, symbols. Avoid common words, keyboard patterns and your name.">
          <Input id="password" type="password" autoComplete="new-password" required minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Button type="submit" className="w-full" disabled={busy}>{busy && <Spinner className="text-accent-fg" />}Create account</Button>
        <p className="text-center text-xs text-subtle">By creating an account you agree to the <Link to="/legal/terms" className="hover:text-fg underline">Terms</Link> and <Link to="/legal/privacy" className="hover:text-fg underline">Privacy policy</Link>.</p>
        <p className="text-center text-sm text-muted">Already have an account? <Link to="/login" className="font-medium text-accent hover:underline">Log in</Link></p>
      </form>
    </AuthLayout>
  );
}

const DEMO_EMAIL = "demo@aurex.example";
const DEMO_ADMIN_EMAIL = "admin@aurex.example";
const DEMO_PASSWORD = "Demo-Account-2026!";

/** One-click entry for the static demo: a trader with £100 (or US$100,000), or the separate admin console. */
function DemoLaunch({ onError, onChallenge, onBusy, large = false, admin = false }: {
  onError: (e: unknown) => void; onChallenge: (token: string) => void; onBusy: (b: boolean) => void; large?: boolean; admin?: boolean;
}) {
  const { register, login } = useAuth();
  const [busy, setBusy] = useState(false);
  async function launch() {
    setBusy(true); onBusy(true);
    try {
      const email = admin ? DEMO_ADMIN_EMAIL : DEMO_EMAIL;
      try { await register(email, admin ? "Demo Administrator" : "Demo Trader", DEMO_PASSWORD); }
      catch (e) { if (!(e instanceof ApiError && e.status === 409)) throw e; }
      const challenge = await login(email, DEMO_PASSWORD);
      if (challenge) { onChallenge(challenge.mfaToken); return; }
      if (!admin) {
        const accounts = await api<TradingAccount[]>("/accounts");
        if (accounts.length === 0) {
          await api("/accounts", { method: "POST", json: large
            ? { name: "Demo paper account", base_currency: "USD", starting_balance: "100000" }
            : { name: "£100 paper account", base_currency: "GBP", starting_balance: "100" } });
        }
      }
    } catch (e) { onError(e); } finally { setBusy(false); onBusy(false); }
  }
  const label = admin ? "Explore the admin console" : large ? "Launch demo with US$100,000" : "Launch demo";
  return (
    <Button type="button" variant={admin ? "ghost" : large ? "outline" : "secondary"} className="w-full" onClick={launch} disabled={busy}>
      {busy && <Spinner />}{label}
    </Button>
  );
}
