'use client';

import Link from 'next/link';
import { ArrowLeft, Check, KeyRound, ShieldCheck, Users } from 'lucide-react';
import { UserRegistrationForm } from '@/features/user-registration';

export default function RegisterPage() {
  return (
    <main className="login-shell">
      <section className="login-scene" aria-label="SocietyOS resident onboarding">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <div className="brand-name" style={{ fontSize: 22 }}>
              SocietyOS
            </div>
            <span className="brand-sub" style={{ color: 'rgba(242,247,239,.5)' }}>
              Residential operations & gate access
            </span>
          </div>
        </div>

        <div className="login-copy">
          <h1 className="login-title display">
            Register your home,
            <br />
            invite your relatives.
          </h1>
          <p className="login-lede">
            Join your residential society network. Seamlessly register your household, invite relatives
            and guests with time-limited QR and PIN passes, and monitor access securely in real time.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, margin: '20px 0', maxWidth: 440 }}>
          <div style={{ background: 'rgba(255,255,255,0.06)', padding: 12, borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--amber)', fontSize: 13, fontWeight: 700 }}>
              <Users size={14} /> Relatives Directory
            </div>
            <p style={{ color: 'rgba(242,247,239,0.7)', fontSize: 11, marginTop: 4, lineHeight: 1.4 }}>
              Register family members once. Issue 1-click passes anytime.
            </p>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.06)', padding: 12, borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--amber)', fontSize: 13, fontWeight: 700 }}>
              <KeyRound size={14} /> Hardware Gates
            </div>
            <p style={{ color: 'rgba(242,247,239,0.7)', fontSize: 11, marginTop: 4, lineHeight: 1.4 }}>
              Boom barriers and turnstiles verify credentials atomically.
            </p>
          </div>
        </div>

        <div style={{ position: 'relative', zIndex: 1, display: 'flex', gap: 18, color: 'rgba(242,247,239,.55)', fontSize: 11 }}>
          <span style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}>
            <ShieldCheck size={13} /> Tenant isolation
          </span>
          <span style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}>
            <Check size={13} /> Immediate gate credentials
          </span>
        </div>
      </section>

      <section className="login-panel" aria-label="Create account">
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <h2 className="login-form-title" style={{ margin: 0 }}>
              Resident Sign Up
            </h2>
            <Link href="/login" className="btn-ghost btn-small" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <ArrowLeft size={13} /> Back to Sign In
            </Link>
          </div>
          <p className="login-form-sub">
            Create your resident account and link your apartment flat.
          </p>

          <UserRegistrationForm />

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--line)', textAlign: 'center' }}>
            <span className="small muted">Already have an account? </span>
            <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600, fontSize: 13, textDecoration: 'none' }}>
              Sign in here
            </Link>
            <div style={{ marginTop: 8 }}>
              <span className="small muted">Are you a guest or delivery partner? </span>
              <Link href="/visitor-register" style={{ color: 'var(--amber)', fontWeight: 600, fontSize: 13, textDecoration: 'none' }}>
                Self-register gate pass
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
