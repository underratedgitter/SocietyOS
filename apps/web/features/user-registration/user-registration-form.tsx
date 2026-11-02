'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CheckCircle2, ShieldCheck } from 'lucide-react';
import { useSession } from '@/components/session-provider';
import { Notice, errorMessage } from '@/components/ui';
import { fetchPublicFlats, fetchPublicSocieties, submitUserRegistration } from './api';
import type { PublicFlatSummary, PublicSocietySummary, RegistrationFormState } from './types';

export function UserRegistrationForm() {
  const router = useRouter();
  const { reload } = useSession();

  const [societies, setSocieties] = useState<PublicSocietySummary[]>([]);
  const [flats, setFlats] = useState<PublicFlatSummary[]>([]);
  const [loadingSocieties, setLoadingSocieties] = useState(true);
  const [loadingFlats, setLoadingFlats] = useState(false);

  const [form, setForm] = useState<RegistrationFormState>({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    phone: '',
    societyId: '',
    flatId: '',
    relationship: 'OWNER',
  });

  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [registeredSuccess, setRegisteredSuccess] = useState(false);

  // Load public societies
  useEffect(() => {
    let active = true;
    fetchPublicSocieties()
      .then((data) => {
        if (!active) return;
        setSocieties(data);
        if (data.length > 0) {
          setForm((prev) => ({ ...prev, societyId: data[0].id }));
        }
      })
      .catch((err) => {
        if (active) setError(errorMessage(err));
      })
      .finally(() => {
        if (active) setLoadingSocieties(false);
      });

    return () => {
      active = false;
    };
  }, []);

  // Load flats when selected society changes
  useEffect(() => {
    if (!form.societyId) {
      setFlats([]);
      return;
    }

    let active = true;
    setLoadingFlats(true);
    fetchPublicFlats(form.societyId)
      .then((data) => {
        if (!active) return;
        setFlats(data);
        if (data.length > 0) {
          setForm((prev) => ({ ...prev, flatId: data[0].id }));
        } else {
          setForm((prev) => ({ ...prev, flatId: '' }));
        }
      })
      .catch(() => {
        if (active) setFlats([]);
      })
      .finally(() => {
        if (active) setLoadingFlats(false);
      });

    return () => {
      active = false;
    };
  }, [form.societyId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');

    if (form.password.length < 8) {
      return setError('Password must be at least 8 characters.');
    }
    if (form.password !== form.confirmPassword) {
      return setError('Passwords do not match.');
    }
    if (!form.societyId) {
      return setError('Please choose your residential society.');
    }

    setSubmitting(true);
    try {
      await submitUserRegistration({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        phone: form.phone.trim() || undefined,
        societyId: form.societyId,
        flatId: form.flatId || undefined,
        relationship: form.flatId ? form.relationship : undefined,
      });

      setRegisteredSuccess(true);
      await reload();

      // Navigate to resident workspace
      setTimeout(() => {
        router.replace('/resident');
      }, 1200);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  if (registeredSuccess) {
    return (
      <div style={{ textAlign: 'center', padding: '32px 16px' }}>
        <CheckCircle2 size={48} color="var(--primary)" style={{ margin: '0 auto 16px' }} />
        <h3 className="login-form-title" style={{ fontSize: 22 }}>Welcome to SocietyOS!</h3>
        <p className="login-form-sub" style={{ marginTop: 8 }}>
          Your account and flat profile have been configured. Taking you to your resident dashboard…
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="stack" noValidate>
      {error ? <Notice danger>{error}</Notice> : null}

      {/* Society Selection */}
      <div className="field">
        <label className="label" htmlFor="reg-society">
          Residential Society *
        </label>
        <div style={{ position: 'relative' }}>
          <select
            className="select"
            id="reg-society"
            required
            disabled={loadingSocieties}
            value={form.societyId}
            onChange={(e) => setForm({ ...form, societyId: e.target.value })}
          >
            {societies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.slug})
              </option>
            ))}
          </select>
        </div>
        <span className="tiny muted" style={{ marginTop: 4 }}>
          Choose your residential community. Access control will be scoped to this society.
        </span>
      </div>

      {/* Flat Selection */}
      <div className="form-grid">
        <div className="field">
          <label className="label" htmlFor="reg-flat">
            Building & Flat Number
          </label>
          <select
            className="select"
            id="reg-flat"
            disabled={loadingFlats || flats.length === 0}
            value={form.flatId}
            onChange={(e) => setForm({ ...form, flatId: e.target.value })}
          >
            {flats.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <span className="tiny muted" style={{ marginTop: 4 }}>
            {flats.length === 0 ? 'No flats listed yet.' : 'Select your flat in the complex.'}
          </span>
        </div>

        <div className="field">
          <label className="label" htmlFor="reg-relationship">
            Occupancy Type
          </label>
          <select
            className="select"
            id="reg-relationship"
            value={form.relationship}
            onChange={(e) => setForm({ ...form, relationship: e.target.value as 'OWNER' | 'TENANT' | 'FAMILY' })}
          >
            <option value="OWNER">Flat Owner</option>
            <option value="TENANT">Tenant / Resident</option>
            <option value="FAMILY">Family Member</option>
          </select>
        </div>
      </div>

      {/* User Information */}
      <div className="field">
        <label className="label" htmlFor="reg-name">
          Full Name *
        </label>
        <input
          className="input"
          id="reg-name"
          name="name"
          required
          minLength={2}
          maxLength={100}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="e.g. Vikram Singhania"
        />
      </div>

      <div className="form-grid">
        <div className="field">
          <label className="label" htmlFor="reg-email">
            Email Address *
          </label>
          <input
            className="input"
            id="reg-email"
            name="email"
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="vikram@example.com"
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="reg-phone">
            Phone Number (Optional)
          </label>
          <input
            className="input"
            id="reg-phone"
            name="phone"
            type="tel"
            maxLength={20}
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            placeholder="+91 98765 43210"
          />
        </div>
      </div>

      {/* Password & Confirm */}
      <div className="form-grid">
        <div className="field">
          <label className="label" htmlFor="reg-password">
            Password *
          </label>
          <input
            className="input"
            id="reg-password"
            name="password"
            type="password"
            required
            minLength={8}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="At least 8 characters"
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="reg-confirm">
            Confirm Password *
          </label>
          <input
            className="input"
            id="reg-confirm"
            name="confirmPassword"
            type="password"
            required
            minLength={8}
            value={form.confirmPassword}
            onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
            placeholder="Re-enter password"
          />
        </div>
      </div>

      <div className="notice" style={{ marginTop: 4 }}>
        <ShieldCheck size={16} style={{ flex: 'none', marginTop: 2, color: 'var(--primary)' }} />
        <span>
          Your account is secured with scoped session cookies and bcrypt password hashing. After registration,
          you can immediately issue passes for relatives and guests.
        </span>
      </div>

      <button
        className="btn btn-primary"
        type="submit"
        disabled={submitting || loadingSocieties}
        style={{ marginTop: 8, minHeight: 44 }}
      >
        {submitting ? 'Creating account…' : 'Complete Registration & Sign In'}
        {!submitting ? <ArrowRight size={15} /> : null}
      </button>
    </form>
  );
}
