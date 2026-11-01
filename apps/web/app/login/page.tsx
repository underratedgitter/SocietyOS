'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, KeyRound, ShieldCheck } from 'lucide-react';
import { useSession, homeFor } from '@/components/session-provider';
import { Notice, errorMessage } from '@/components/ui';

const DEMO_ACCOUNTS = [
  { label: 'Platform operator', email: 'platform@societyos.dev', password: 'Platform#2026' },
  { label: 'Palm Grove admin', email: 'admin.a@societyos.dev', password: 'AdminA#2026' },
  { label: 'Palm Grove guard', email: 'guard.a@societyos.dev', password: 'GuardA#2026' },
  { label: 'Resident 101', email: 'resident.a1@societyos.dev', password: 'Society#2026' },
];

export default function LoginPage() {
  const router = useRouter();
  const { session, loading, login } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && session) {
      router.replace(session.user.mustChangePassword ? '/change-password' : homeFor(session));
    }
  }, [loading, session, router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const next = await login(email.trim(), password);
      router.replace(next.user.mustChangePassword ? '/change-password' : homeFor(next));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-scene" aria-label="SocietyOS introduction">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <div className="brand-name" style={{ fontSize: 22 }}>
              SocietyOS
            </div>
            <span className="brand-sub" style={{ color: 'rgba(242,247,239,.5)' }}>
              Residential operations
            </span>
          </div>
        </div>

        <div className="login-copy">
          <h1 className="login-title display">
            Every arrival,
            <br />
            accounted for.
          </h1>
          <p className="login-lede">
            One ledger for residents, visitors, guards and the gate itself. Authorize with a time-bound
            pass, watch the controller answer, and keep the evidence.
          </p>
        </div>

        <div className="gate-diagram" aria-hidden="true">
          <span>Closed</span>
          <span className="gate-bar" />
          <span>Authorized</span>
          <span style={{ color: 'var(--amber)' }}>Open</span>
        </div>

        <div style={{ position: 'relative', zIndex: 1, display: 'flex', gap: 18, marginTop: 18, color: 'rgba(242,247,239,.55)', fontSize: 11 }}>
          <span style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}>
            <ShieldCheck size={13} /> Tenant-isolated by default
          </span>
          <span style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}>
            <KeyRound size={13} /> Signed gate commands
          </span>
        </div>
      </section>

      <section className="login-panel" aria-label="Sign in">
        <div>
          <h2 className="login-form-title">Sign in</h2>
          <p className="login-form-sub">Use your society account. Access follows your role and flat.</p>

          <form onSubmit={onSubmit} className="stack" noValidate>
            {error ? <Notice danger>{error}</Notice> : null}
            <div className="field">
              <label className="label" htmlFor="email">
                Email address
              </label>
              <input
                className="input"
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@society.dev"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="password">
                Password
              </label>
              <input
                className="input"
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 8 characters"
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={submitting} style={{ marginTop: 4, minHeight: 42 }}>
              {submitting ? 'Signing in…' : 'Sign in'}
              {!submitting ? <ArrowRight size={15} /> : null}
            </button>
          </form>

          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
            <div>
              <span className="muted">New resident in this society? </span>
              <Link href="/register" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
                Register your account →
              </Link>
            </div>
            <div>
              <span className="muted">Visitor, relative or guest? </span>
              <Link href="/visitor-register" style={{ color: 'var(--amber-ink)', fontWeight: 600, textDecoration: 'none' }}>
                Self-register for gate pass →
              </Link>
            </div>
          </div>

          {process.env.NODE_ENV !== 'production' && (
            <div className="demo-accounts">
              <div className="tiny muted">Local demo accounts</div>
              <div className="demo-list">
                {DEMO_ACCOUNTS.map((account) => (
                  <button
                    key={account.email}
                    type="button"
                    className="demo-account"
                    onClick={() => {
                      setEmail(account.email);
                      setPassword(account.password);
                      setError('');
                    }}
                  >
                    <strong>{account.label}</strong>
                    {account.email}
                  </button>
                ))}
              </div>
              <p className="hint" style={{ marginTop: 10 }}>
                Seeded accounts are for local demonstration. Production onboarding issues one-time temporary
                passwords and forces a change at first sign-in.
              </p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
