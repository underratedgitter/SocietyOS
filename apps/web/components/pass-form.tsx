'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { KeyRound, QrCode, Zap } from 'lucide-react';
import { apiRequest } from '@/lib/api';
import type { AccessPoint, FlatOption, PassWithCredentials, VisitorCategory } from '@/lib/types';
import { Notice, errorMessage } from './ui';

const CATEGORIES: { value: VisitorCategory; label: string }[] = [
  { value: 'RELATIVE', label: 'Relative' },
  { value: 'FRIEND', label: 'Friend' },
  { value: 'DELIVERY', label: 'Delivery' },
  { value: 'CAB', label: 'Cab' },
  { value: 'MAINTENANCE', label: 'Maintenance' },
  { value: 'OTHER', label: 'Other' },
];

function localInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function PassForm({
  flats,
  accessPoints,
  defaultFlatId,
  onCreated,
}: {
  flats: FlatOption[];
  accessPoints: AccessPoint[];
  defaultFlatId?: string;
  onCreated: (result: PassWithCredentials, meta?: { vehicle?: string; purpose?: string }) => void;
}) {
  const initialFrom = useMemo(() => localInput(new Date()), []);
  const initialUntil = useMemo(() => localInput(new Date(Date.now() + 4 * 3600_000)), []);
  const [flatId, setFlatId] = useState(defaultFlatId || flats[0]?.id || '');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [category, setCategory] = useState<VisitorCategory>('RELATIVE');
  const [from, setFrom] = useState(initialFrom);
  const [until, setUntil] = useState(initialUntil);
  const [maxUses, setMaxUses] = useState(1);
  const [gateIds, setGateIds] = useState<string[]>(accessPoints[0] ? [accessPoints[0].id] : []);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [idempotencyKey] = useState(() => (globalThis.crypto?.randomUUID?.() ?? `pass-${Date.now()}`));

  function applyPreset(
    cat: VisitorCategory,
    durationMinutes: number,
    uses = 1,
    defaultName = '',
    defaultPurpose = '',
  ) {
    const now = new Date();
    const end = new Date(now.getTime() + durationMinutes * 60_000);
    setCategory(cat);
    setFrom(localInput(now));
    setUntil(localInput(end));
    setMaxUses(uses);
    if (defaultName && !name) {
      setName(defaultName);
    }
    if (defaultPurpose && !purpose) {
      setPurpose(defaultPurpose);
    }
  }

  function toggleGate(id: string) {
    setGateIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (!flatId) return setError('Choose a flat.');
    if (gateIds.length === 0) return setError('Select at least one gate.');
    const validFrom = new Date(from);
    const validUntil = new Date(until);
    if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validUntil.getTime())) {
      return setError('Enter a valid arrival window.');
    }
    if (validUntil <= validFrom) return setError('The window must end after it begins.');
    const trimmedName = name.trim();
    if (trimmedName.length < 2) {
      return setError('Enter a visitor name (at least 2 characters).');
    }
    const trimmedVehicle = vehicle.trim().toUpperCase();
    const trimmedPurpose = purpose.trim();
    let visitorName = trimmedName;
    if (trimmedVehicle) {
      const vehicleTag = ` [${trimmedVehicle}]`;
      const maxNameLen = Math.max(2, 120 - vehicleTag.length);
      visitorName = `${trimmedName.slice(0, maxNameLen)}${vehicleTag}`;
    }

    setSubmitting(true);
    try {
      const result = await apiRequest<PassWithCredentials>('/api/v1/visitor-passes', {
        method: 'POST',
        idempotencyKey,
        body: JSON.stringify({
          flatId,
          visitor: { name: visitorName, ...(phone.trim() ? { phone: phone.trim() } : {}) },
          category,
          validFrom: validFrom.toISOString(),
          validUntil: validUntil.toISOString(),
          maxUses,
          accessPointIds: gateIds,
        }),
      });
      onCreated(result, { vehicle: trimmedVehicle, purpose: trimmedPurpose });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      {error ? <Notice danger>{error}</Notice> : null}

      <div className="presets-row">
        <span className="small muted" style={{ alignSelf: 'center', marginRight: 4 }}>
          Fast presets:
        </span>
        <button
          type="button"
          className="preset-pill"
          onClick={() => applyPreset('DELIVERY', 20, 1, 'Delivery Partner', 'Parcel Delivery')}
        >
          <Zap size={12} color="var(--amber)" /> Delivery (20m)
        </button>
        <button
          type="button"
          className="preset-pill"
          onClick={() => applyPreset('CAB', 30, 1, 'Cab Driver', 'Cab Pickup / Drop')}
        >
          🚕 Cab (30m)
        </button>
        <button
          type="button"
          className="preset-pill"
          onClick={() => applyPreset('FRIEND', 240, 1, '', 'Guest Visit')}
        >
          🍷 Guest (4h)
        </button>
        <button
          type="button"
          className="preset-pill"
          onClick={() => applyPreset('MAINTENANCE', 480, 2, 'Service Technician', 'Maintenance / Repair')}
        >
          🔧 Service (8h)
        </button>
      </div>

      <div className="form-grid">
        <div className="field">
          <label className="label" htmlFor="pass-flat">Host flat</label>
          <select
            className="select"
            id="pass-flat"
            required
            value={flatId}
            onChange={(event) => setFlatId(event.target.value)}
          >
            {flats.map((flat) => (
              <option key={flat.id} value={flat.id}>
                {flat.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="pass-category">Visitor category</label>
          <select
            className="select"
            id="pass-category"
            value={category}
            onChange={(event) => setCategory(event.target.value as VisitorCategory)}
          >
            {CATEGORIES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="pass-name">Visitor name</label>
          <input
            className="input"
            id="pass-name"
            required
            minLength={2}
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Rahul Sharma"
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="pass-phone">Phone (optional)</label>
          <input
            className="input"
            id="pass-phone"
            value={phone}
            maxLength={20}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="+91 98765 43210"
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="pass-vehicle">Vehicle (optional)</label>
          <input
            className="input"
            id="pass-vehicle"
            value={vehicle}
            maxLength={20}
            onChange={(event) => setVehicle(event.target.value)}
            placeholder="e.g. MH 02 AB 1234 or Uber/Ola"
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="pass-purpose">Purpose (optional)</label>
          <input
            className="input"
            id="pass-purpose"
            value={purpose}
            maxLength={60}
            onChange={(event) => setPurpose(event.target.value)}
            placeholder="e.g. Parcel delivery, social visit"
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="pass-from">Valid from</label>
          <input
            className="input"
            id="pass-from"
            type="datetime-local"
            required
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="pass-until">Valid until</label>
          <input
            className="input"
            id="pass-until"
            type="datetime-local"
            required
            value={until}
            onChange={(event) => setUntil(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="pass-uses">Maximum uses</label>
          <input
            className="input"
            id="pass-uses"
            type="number"
            min={1}
            max={10}
            value={maxUses}
            onChange={(event) => setMaxUses(Number(event.target.value))}
          />
        </div>
        <div className="field">
          <span className="label">Authorized gates</span>
          <div className="check-row">
            {accessPoints.map((gate) => (
              <label className="check-chip" key={gate.id}>
                <input
                  type="checkbox"
                  checked={gateIds.includes(gate.id)}
                  onChange={() => toggleGate(gate.id)}
                />
                {gate.name}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="notice">
        <KeyRound size={15} style={{ flex: 'none', marginTop: 2 }} />
        <span>
          The backend issues a six-digit PIN and a high-entropy QR token once. Only keyed hashes are stored;
          the credential is consumed atomically at the gate.
        </span>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
        <button className="btn btn-primary" type="submit" disabled={submitting || flats.length === 0}>
          <QrCode size={15} />
          {submitting ? 'Issuing pass…' : 'Issue visitor pass'}
        </button>
      </div>
    </form>
  );
}
