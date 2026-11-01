'use client';

import { useState, type FormEvent } from 'react';
import { KeyRound, Sparkles, UserPlus, Users } from 'lucide-react';
import { Modal, Notice, errorMessage } from '@/components/ui';
import { registerRelative } from './api';
import type { QuickPassResult, RelativeMember } from './types';

const RELATION_TAGS = [
  'Mother',
  'Father',
  'Parents',
  'Brother',
  'Sister',
  'Spouse',
  'Son',
  'Daughter',
  'Grandparent',
  'In-Laws',
  'Uncle / Aunt',
  'Cousin',
  'Extended Family',
];

export function RegisterRelativeModal({
  flatId,
  onClose,
  onRegistered,
}: {
  flatId: string;
  onClose: () => void;
  onRegistered: (relative: RelativeMember, pass?: any) => void;
}) {
  const [name, setName] = useState('');
  const [relation, setRelation] = useState('Parents');
  const [phone, setPhone] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');

    const trimmedName = name.trim();
    if (!trimmedName) {
      return setError('Please enter the relative full name.');
    }

    setSubmitting(true);
    try {
      const response = await registerRelative(flatId, {
        name: trimmedName,
        relation,
        phone: phone.trim() || undefined,
        defaultVehicle: vehicle.trim() || undefined,
        notes: notes.trim() || undefined,
      });

      onRegistered(response.relative, response.initialPass);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Register Relative or Family Member" onClose={onClose}>
      <form onSubmit={handleSubmit} className="stack">
        {error ? <Notice danger>{error}</Notice> : null}

        {/* Relation Tag Pills */}
        <div className="field">
          <label className="label">Relationship</label>
          <div className="check-row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {RELATION_TAGS.map((tag) => {
              const active = relation === tag;
              return (
                <button
                  type="button"
                  key={tag}
                  className="preset-pill"
                  style={{
                    background: active ? 'var(--ink)' : 'var(--paper)',
                    color: active ? '#FFFFFF' : 'var(--charcoal)',
                    borderColor: active ? 'var(--ink)' : 'var(--line)',
                    fontWeight: active ? 700 : 500,
                  }}
                  onClick={() => setRelation(tag)}
                >
                  {tag}
                </button>
              );
            })}
          </div>
        </div>

        {/* Name & Phone */}
        <div className="field">
          <label className="label" htmlFor="rel-name">
            Relative Full Name *
          </label>
          <input
            className="input"
            id="rel-name"
            required
            minLength={2}
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Ramesh Patel"
          />
        </div>

        <div className="form-grid">
          <div className="field">
            <label className="label" htmlFor="rel-phone">
              Mobile Phone
            </label>
            <input
              className="input"
              id="rel-phone"
              type="tel"
              maxLength={20}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="rel-vehicle">
              Vehicle Plate (Optional)
            </label>
            <input
              className="input"
              id="rel-vehicle"
              maxLength={20}
              value={vehicle}
              onChange={(e) => setVehicle(e.target.value)}
              placeholder="e.g. MH 02 CZ 4411"
            />
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="rel-notes">
            Notes / Visit Schedule (Optional)
          </label>
          <input
            className="input"
            id="rel-notes"
            maxLength={200}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Visits every weekend or during holidays"
          />
        </div>

        <div className="notice" style={{ marginTop: 2 }}>
          <KeyRound size={15} style={{ flex: 'none', marginTop: 2, color: 'var(--amber)' }} />
          <span>
            Registering a relative saves them to your flat's family directory. An initial entry pass with
            a PIN and QR token will be generated immediately so you can share it with them.
          </span>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            <Sparkles size={14} />
            {submitting ? 'Registering…' : 'Register Relative & Issue Pass'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
