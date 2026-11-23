import { ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { Logo } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/form";
import { useAuth } from "@/features/auth/AuthProvider";
import { api, ApiError, isDemo, type TradingAccount } from "@/services/api";

function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[1fr_520px]">
      <section className="relative hidden overflow-hidden border-r border-border bg-surface lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{ backgroundImage: "linear-gradient(var(--color-fg) 1px, transparent 1px), linear-gradient(90deg, var(--color-fg) 1px, transparent 1px)", backgroundSize: "48px 48px" }} />
        <Logo />
        <div className="relative max-w-lg">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            Autonomous research and execution, <span className="text-accent">governed by an independent risk gate.</span>
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            AUREX AI analyses crypto, FX, equities and ETFs with specialist agents and quantitative models.
            Every proposal is validated by a risk controller with final authority before any simulated order is placed.
          </p>
        </div>
        <div className="relative flex items-center gap-2 text-xs text-subtle">
          <ShieldCheck className="size-4 text-accent" />
          Stage 1 · Paper trading with virtual capital only. No real money is moved.
        </div>
      </section>
      <section className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <Logo className="mb-8 lg:hidden" />
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
          {isDemo && (
            <div className="mt-5 rounded-md border border-info/40 bg-info/10 px-3 py-2.5 text-xs leading-relaxed text-info">
              <strong>Public demo.</strong> This build runs entirely in your browser: accounts, balances and prices
              are simulated and stored only on this device. The production system runs the FastAPI backend.
            </div>
          )}
          <div className="mt-6">{children}</div>
        </div>
      </section>
    </div>
  );
}

export function LoginPage() {
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (status === "authenticated") return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await login(email, password); navigate("/", { replace: true }); }
    catch (err) { setError(err); }
    finally { setBusy(false); }
  }

  return (
    <AuthLayout title="Sign in" subtitle="Access the AUREX trading terminal.">
      <form onSubmit={submit} className="space-y-4">
        <ErrorBanner error={error} />
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" disabled={busy}>{busy && <Spinner className="text-accent-fg" />}Sign in</Button>
        {isDemo && <DemoLaunch onError={setError} />}
        <p className="text-center text-xs text-muted">No account? <Link to="/register" className="text-accent hover:underline">Create one</Link></p>
      </form>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { register, login, status } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (status === "authenticated") return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await register(form.email, form.name, form.password);
      await login(form.email, form.password);
      navigate("/", { replace: true });
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <AuthLayout title="Create your account" subtitle="Start with a virtual paper-trading account.">
      <form onSubmit={submit} className="space-y-4">
        <ErrorBanner error={error} />
        <Field label="Full name" htmlFor="name">
          <Input id="name" autoComplete="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 12 characters, using three of: lowercase, uppercase, digits, symbols.">
          <Input id="password" type="password" autoComplete="new-password" required minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Button type="submit" className="w-full" disabled={busy}>{busy && <Spinner className="text-accent-fg" />}Create account</Button>
        <p className="text-center text-xs text-muted">Already registered? <Link to="/login" className="text-accent hover:underline">Sign in</Link></p>
      </form>
    </AuthLayout>
  );
}

const DEMO_EMAIL = "demo@aurex.example";
const DEMO_PASSWORD = "Demo-Account-2026!";

/** One-click entry for the static demo: creates the demo user and a funded paper account. */
function DemoLaunch({ onError }: { onError: (e: unknown) => void }) {
  const { register, login } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  async function launch() {
    setBusy(true);
    try {
      try { await register(DEMO_EMAIL, "Demo Trader", DEMO_PASSWORD); }
      catch (e) { if (!(e instanceof ApiError && e.status === 409)) throw e; }
      await login(DEMO_EMAIL, DEMO_PASSWORD);
      const accounts = await api<TradingAccount[]>("/accounts");
      if (accounts.length === 0) {
        await api("/accounts", { method: "POST", json: { name: "Demo paper account", base_currency: "USD", starting_balance: "100000" } });
        await api("/research/samples", { method: "POST" });
      }
      navigate("/", { replace: true });
    } catch (e) { onError(e); } finally { setBusy(false); }
  }
  return (
    <Button type="button" variant="secondary" className="w-full" onClick={launch} disabled={busy}>
      {busy && <Spinner />}Launch demo
    </Button>
  );
}
