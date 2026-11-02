'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound, QrCode } from 'lucide-react';
import { Notice, errorMessage } from '@/components/ui';
import { fetchPublicFlats, fetchPublicSocieties, submitVisitorSelfRegistration } from './api';
import { VisitorPassModal } from './visitor-pass-modal';
import type {
  PublicFlatSummary,
  PublicSocietySummary,
} from '@/features/user-registration/types';
import type {
  SelfRegisterVisitorResponse,
  VisitorCategory,
  VisitorRegistrationFormState,
} from './types';

const CATEGORY_PRESETS: {
  category: VisitorCategory;
  label: string;
  defaultDuration: number;
  icon: string;
  defaultPurpose: string;
}[] = [
  {
    category: 'RELATIVE',
    label: 'Family / Relative',
    defaultDuration: 1440, // 24 hours
    icon: '👨‍👩‍👧',
    defaultPurpose: 'Family stay / visit',
  },
  {
    category: 'FRIEND',
    label: 'Guest / Friend',
    defaultDuration: 240, // 4 hours
    icon: '🍷',
    defaultPurpose: 'Social visit',
  },
  {
    category: 'DELIVERY',
    label: 'Delivery Partner',
    defaultDuration: 30, // 30 mins
    icon: '📦',
    defaultPurpose: 'Parcel delivery',
  },
  {
    category: 'CAB',
    label: 'Cab / Driver',
    defaultDuration: 30, // 30 mins
    icon: '🚕',
    defaultPurpose: 'Pickup / drop',
  },
  {
    category: 'MAINTENANCE',
    label: 'Technician / Service',
    defaultDuration: 480, // 8 hours
    icon: '🔧',
    defaultPurpose: 'Home maintenance / repair',
  },
  {
    category: 'OTHER',
    label: 'Other',
    defaultDuration: 120, // 2 hours
    icon: '📋',
    defaultPurpose: 'Personal visit',
  },
];

export function VisitorRegistrationForm({
  initialSocietyId,
  initialFlatId,
}: {
  initialSocietyId?: string;
  initialFlatId?: string;
}) {
  const [societies, setSocieties] = useState<PublicSocietySummary[]>([]);
  const [flats, setFlats] = useState<PublicFlatSummary[]>([]);
  const [loadingSocieties, setLoadingSocieties] = useState(true);
  const [loadingFlats, setLoadingFlats] = useState(false);

  const [form, setForm] = useState<VisitorRegistrationFormState>({
    societyId: initialSocietyId || '',
    flatId: initialFlatId || '',
    visitorName: '',
    visitorPhone: '',
    category: 'RELATIVE',
    vehicle: '',
    purpose: 'Family stay / visit',
    durationMinutes: 1440,
  });

  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [issuedPass, setIssuedPass] = useState<SelfRegisterVisitorResponse | null>(null);

  useEffect(() => {
    let active = true;
    fetchPublicSocieties()
      .then((data) => {
        if (!active) return;
        setSocieties(data);
        if (!form.societyId && data.length > 0) {
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
  }, [form.societyId]);

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
        setForm((prev) => ({
          ...prev,
          flatId: data.length > 0 ? data[0].id : '',
        }));
      })
      .catch(() => {
        if (active) {
          setFlats([]);
          setForm((prev) => ({ ...prev, flatId: '' }));
        }
      })
      .finally(() => {
        if (active) setLoadingFlats(false);
      });

    return () => {
      active = false;
    };
  }, [form.societyId]);

  function handleSelectCategory(item: (typeof CATEGORY_PRESETS)[number]) {
    setForm((prev) => ({
      ...prev,
      category: item.category,
      durationMinutes: item.defaultDuration,
      purpose: prev.purpose && prev.purpose !== 'Family stay / visit' ? prev.purpose : item.defaultPurpose,
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');

    if (!form.societyId) {
      return setError('Please select the society you are visiting.');
    }
    if (!form.flatId) {
      return setError('Please select the flat or apartment number you are visiting.');
    }
    if (!form.visitorName.trim()) {
      return setError('Please enter your full name.');
    }

    setSubmitting(true);
    try {
      const response = await submitVisitorSelfRegistration({
        societyId: form.societyId,
        flatId: form.flatId,
        visitorName: form.visitorName.trim(),
        visitorPhone: form.visitorPhone.trim() || undefined,
        category: form.category,
        vehicle: form.vehicle.trim() || undefined,
        purpose: form.purpose.trim() || undefined,
        expectedDurationMinutes: form.durationMinutes,
      });

      setIssuedPass(response);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="stack" noValidate>
        {error ? <Notice danger>{error}</Notice> : null}

        {/* Category Pill Selection */}
        <div className="field">
          <label className="label">I am visiting as</label>
          <div className="check-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            {CATEGORY_PRESETS.map((item) => {
              const active = form.category === item.category;
              return (
                <button
                  type="button"
                  key={item.category}
                  className="preset-pill"
                  style={{
                    background: active ? 'var(--ink)' : 'var(--paper)',
                    color: active ? '#FFFFFF' : 'var(--charcoal)',
                    borderColor: active ? 'var(--ink)' : 'var(--line)',
                    fontWeight: active ? 700 : 500,
                    padding: '8px 14px',
                  }}
                  onClick={() => handleSelectCategory(item)}
                >
                  <span style={{ marginRight: 4 }}>{item.icon}</span> {item.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Society & Destination Flat */}
        <div className="form-grid">
          <div className="field">
            <label className="label" htmlFor="vis-society">
              Residential Society *
            </label>
            <select
              className="select"
              id="vis-society"
              required
              disabled={loadingSocieties}
              value={form.societyId}
              onChange={(e) => setForm({ ...form, societyId: e.target.value })}
            >
              {societies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="label" htmlFor="vis-flat">
              Destination Apartment / Flat *
            </label>
            <select
              className="select"
              id="vis-flat"
              required
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
          </div>
        </div>

        {/* Visitor Details */}
        <div className="form-grid">
          <div className="field">
            <label className="label" htmlFor="vis-name">
              Your Full Name *
            </label>
            <input
              className="input"
              id="vis-name"
              required
              minLength={2}
              maxLength={120}
              value={form.visitorName}
              onChange={(e) => setForm({ ...form, visitorName: e.target.value })}
              placeholder={form.category === 'RELATIVE' ? 'e.g. Ramesh Patel' : 'e.g. Priya Sharma'}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="vis-phone">
              Mobile Phone (for SMS/Pass)
            </label>
            <input
              className="input"
              id="vis-phone"
              type="tel"
              maxLength={20}
              value={form.visitorPhone}
              onChange={(e) => setForm({ ...form, visitorPhone: e.target.value })}
              placeholder="+91 98765 43210"
            />
          </div>
        </div>

        {/* Vehicle & Purpose */}
        <div className="form-grid">
          <div className="field">
            <label className="label" htmlFor="vis-vehicle">
              Vehicle Plate No. (Optional)
            </label>
            <input
              className="input"
              id="vis-vehicle"
              maxLength={20}
              value={form.vehicle}
              onChange={(e) => setForm({ ...form, vehicle: e.target.value })}
              placeholder="e.g. MH 02 CZ 4411 or Uber/Ola"
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="vis-purpose">
              Purpose of Visit
            </label>
            <input
              className="input"
              id="vis-purpose"
              maxLength={60}
              value={form.purpose}
              onChange={(e) => setForm({ ...form, purpose: e.target.value })}
              placeholder="e.g. Family dinner, festival, delivery"
            />
          </div>
        </div>

        {/* Notice on Gate Security */}
        <div className="notice" style={{ marginTop: 2 }}>
          <KeyRound size={15} style={{ flex: 'none', marginTop: 2, color: 'var(--amber)' }} />
          <span>
            Upon registration, SocietyOS generates a secure 6-digit gate PIN and a QR code for camera scan.
            Boom barriers and gates open automatically upon verification.
          </span>
        </div>

        <button
          className="btn btn-primary"
          type="submit"
          disabled={submitting || loadingSocieties || flats.length === 0}
          style={{ marginTop: 8, minHeight: 46, fontSize: 15 }}
        >
          {submitting ? 'Issuing Gate Pass…' : 'Generate Visitor Pass & PIN'}
          {!submitting ? <QrCode size={16} /> : null}
        </button>
      </form>

      {issuedPass ? (
        <VisitorPassModal
          pass={issuedPass}
          onClose={() => {
            setIssuedPass(null);
            setForm((prev) => ({
              ...prev,
              visitorName: '',
              visitorPhone: '',
              vehicle: '',
            }));
          }}
        />
      ) : null}
    </>
  );
}
