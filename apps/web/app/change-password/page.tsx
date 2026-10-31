'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { homeFor, useSession } from '@/components/session-provider';
import { LoadingScreen, Notice, errorMessage } from '@/components/ui';

export default function ChangePasswordPage() {
  const { session, loading, updatePassword } = useSession();
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && !session) router.replace('/login');
  }, [loading, session, router]);

  if (loading || !session) return <LoadingScreen />;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== confirm) {
      setError('The new passwords do not match.');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const next = await updatePassword(currentPassword, newPassword);
      router.replace(homeFor(next));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-scene" aria-label="Password security">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <div className="brand-name">SocietyOS</div>
            <span className="brand-sub" style={{ color: 'rgba(242,247,239,.5)' }}>
              Account security
            </span>
          </div>
        </div>
        <div className="login-copy">
          <h1 className="login-title display" style={{ fontSize: 'clamp(42px, 6vw, 78px)' }}>
            A clean key
            <br />
            before the gate.
          </h1>
          <p className="login-lede">
            Temporary passwords are issued once and are never stored in plain text. Replace yours now; all
            other sessions will be revoked.
          </p>
        </div>
        <div className="gate-diagram" aria-hidden="true">
          <span>Credential</span>
          <span className="gate-bar" />
          <span>Rotate</span>
          <span style={{ color: 'var(--amber)' }}>Done</span>
        </div>
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', gap: 8, alignItems: 'center', color: 'rgba(242,247,239,.55)', fontSize: 11 }}>
          <ShieldCheck size={13} /> Keyed verification · session rotation
        </div>
      </section>

      <section className="login-panel" aria-label="Change password">
        <div>
          <h2 className="login-form-title">Set a new password</h2>
          <p className="login-form-sub">
            Signed in as {session.user.email}. Use at least 12 characters; a phrase works well.
          </p>
          <form onSubmit={onSubmit} className="stack" noValidate>
            {error ? <Notice danger>{error}</Notice> : null}
            <div className="field">
              <label className="label" htmlFor="current">
                Current password
              </label>
              <input
                className="input"
                id="current"
                type="password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="next">
                New password
              </label>
              <input
                className="input"
                id="next"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <span className="hint">At least 12 characters. Avoid names and shared phrases.</span>
            </div>
            <div className="field">
              <label className="label" htmlFor="confirm">
                Confirm new password
              </label>
              <input
                className="input"
                id="confirm"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={submitting} style={{ minHeight: 42 }}>
              <KeyRound size={15} />
              {submitting ? 'Updating…' : 'Update password'}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
