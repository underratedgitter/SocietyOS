'use client';

import Link from 'next/link';
import { ArrowLeft, Clock, KeyRound, QrCode, ShieldCheck, Sparkles, UserCheck, Users } from 'lucide-react';
import { VisitorRegistrationForm } from '@/features/visitor-registration';

export default function VisitorRegisterPage() {
  return (
    <main className="login-shell">
      <section className="login-scene" aria-label="SocietyOS visitor registration">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <div className="brand-name" style={{ fontSize: 22 }}>
              SocietyOS
            </div>
            <span className="brand-sub" style={{ color: 'rgba(242,247,239,.5)' }}>
              Self-Service Gate Check-in
            </span>
          </div>
        </div>

        <div className="login-copy">
          <h1 className="login-title display">
            Welcome to the community.
            <br />
            Get your gate pass.
          </h1>
          <p className="login-lede">
            Arriving to meet family, relatives, or delivering an order? Self-register in under 30 seconds
            to generate an instant 6-digit gate PIN and barcode QR credential for boom barrier and turnstile access.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, margin: '20px 0', maxWidth: 440 }}>
          <div style={{ background: 'rgba(255,255,255,0.06)', padding: 12, borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--amber)', fontSize: 13, fontWeight: 700 }}>
              <Users size={14} /> Family & Relatives
            </div>
            <p style={{ color: 'rgba(242,247,239,0.7)', fontSize: 11, marginTop: 4, lineHeight: 1.4 }}>
              Extended family passes valid for up to 24 hours with multiple entries.
            </p>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.06)', padding: 12, borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--amber)', fontSize: 13, fontWeight: 700 }}>
              <KeyRound size={14} /> Instant Keypad PIN
            </div>
            <p style={{ color: 'rgba(242,247,239,0.7)', fontSize: 11, marginTop: 4, lineHeight: 1.4 }}>
              Punch your 6-digit code on the touchscreen at the barrier to open.
            </p>
          </div>
        </div>

        <div style={{ position: 'relative', zIndex: 1, display: 'flex', gap: 18, color: 'rgba(242,247,239,.55)', fontSize: 11 }}>
          <span style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}>
            <ShieldCheck size={13} /> DPDP-compliant encryption
          </span>
          <span style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}>
            <UserCheck size={13} /> Automated host alert
          </span>
        </div>
      </section>

      <section className="login-panel" aria-label="Self-service registration">
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <h2 className="login-form-title" style={{ margin: 0 }}>
              Visitor Registration
            </h2>
            <Link href="/login" className="btn-ghost btn-small" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <ArrowLeft size={13} /> Resident Login
            </Link>
          </div>
          <p className="login-form-sub">
            Select your host resident and receive your entry credentials immediately.
          </p>

          <VisitorRegistrationForm />

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--line)', textAlign: 'center' }}>
            <span className="small muted">Are you a resident of this society? </span>
            <Link href="/register" style={{ color: 'var(--primary)', fontWeight: 600, fontSize: 13, textDecoration: 'none' }}>
              Create Resident Account
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
