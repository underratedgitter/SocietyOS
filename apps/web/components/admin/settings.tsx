'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { apiRequest } from '@/lib/api';
import type { VisitorCategory, VisitorPolicy } from '@/lib/types';
import { Card, Notice, errorMessage } from '../ui';

const CATEGORIES: { value: VisitorCategory; label: string }[] = [
  { value: 'RELATIVE', label: 'Relatives' },
  { value: 'FRIEND', label: 'Friends' },
  { value: 'DELIVERY', label: 'Deliveries' },
  { value: 'CAB', label: 'Cabs' },
  { value: 'MAINTENANCE', label: 'Maintenance' },
  { value: 'OTHER', label: 'Other' },
];

export function SocietySettings({
  societyId,
  initial,
  onSaved,
}: {
  societyId: string;
  initial: VisitorPolicy;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: '',
    timezone: '',
    approvalCategories: initial.approvalCategories,
    maxPassDurationHours: String(initial.maxPassDurationHours),
    maxUsesPerPass: String(initial.maxUsesPerPass),
    maxPassesPerFlatPerDay: String(initial.maxPassesPerFlatPerDay),
  });
  const [policy, setPolicy] = useState<VisitorPolicy>(initial);
  const [details, setDetails] = useState<{ name: string; timezone: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    apiRequest<{ name: string; timezone: string; policy: VisitorPolicy }>(`/api/v1/societies/${societyId}`)
      .then((society) => {
        if (!active) return;
        setDetails({ name: society.name, timezone: society.timezone });
        setPolicy(society.policy);
        setForm((current) => ({
          ...current,
          name: society.name,
          timezone: society.timezone,
          approvalCategories: society.policy.approvalCategories,
          maxPassDurationHours: String(society.policy.maxPassDurationHours),
          maxUsesPerPass: String(society.policy.maxUsesPerPass),
          maxPassesPerFlatPerDay: String(society.policy.maxPassesPerFlatPerDay),
        }));
      })
      .catch((caught) => active && setError(errorMessage(caught)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [societyId]);

  function toggleCategory(category: VisitorCategory) {
    setForm((current) => ({
      ...current,
      approvalCategories: current.approvalCategories.includes(category)
        ? current.approvalCategories.filter((value) => value !== category)
        : [...current.approvalCategories, category],
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const updated = await apiRequest<{ policy: VisitorPolicy }>(`/api/v1/societies/${societyId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...(form.name && form.name !== details?.name ? { name: form.name } : {}),
          ...(form.timezone && form.timezone !== details?.timezone ? { timezone: form.timezone } : {}),
          policy: {
            approvalCategories: form.approvalCategories,
            maxPassDurationHours: Number(form.maxPassDurationHours),
            maxUsesPerPass: Number(form.maxUsesPerPass),
            maxPassesPerFlatPerDay: Number(form.maxPassesPerFlatPerDay),
          },
        }),
      });
      setPolicy(updated.policy);
      setSaved(true);
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="skeleton-block" aria-busy="true" />;
  }

  return (
    <form className="stack" onSubmit={submit}>
      {error ? <Notice danger>{error}</Notice> : null}
      {saved ? <Notice>Settings saved. New passes and approvals use the updated policy.</Notice> : null}

      <Card title="Society profile">
        <div className="form-grid">
          <div className="field">
            <label className="label" htmlFor="society-name">Name</label>
            <input className="input" id="society-name" required maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </div>
          <div className="field">
            <label className="label" htmlFor="society-timezone">Time zone</label>
            <input className="input" id="society-timezone" required maxLength={64} value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} placeholder="Asia/Kolkata" />
          </div>
        </div>
      </Card>

      <Card title="Visitor approval policy" description="Categories selected here must be approved by a resident or admin before the pass becomes usable.">
        <div className="check-row">
          {CATEGORIES.map((category) => (
            <label className="check-chip" key={category.value}>
              <input
                type="checkbox"
                checked={form.approvalCategories.includes(category.value)}
                onChange={() => toggleCategory(category.value)}
              />
              {category.label}
            </label>
          ))}
        </div>
        <div className="form-grid" style={{ marginTop: 18 }}>
          <div className="field">
            <label className="label" htmlFor="policy-duration">Maximum pass duration (hours)</label>
            <input
              className="input"
              id="policy-duration"
              type="number"
              min={1}
              max={720}
              required
              value={form.maxPassDurationHours}
              onChange={(event) => setForm({ ...form, maxPassDurationHours: event.target.value })}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="policy-uses">Maximum entries per pass</label>
            <input
              className="input"
              id="policy-uses"
              type="number"
              min={1}
              max={10}
              required
              value={form.maxUsesPerPass}
              onChange={(event) => setForm({ ...form, maxUsesPerPass: event.target.value })}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="policy-daily">Maximum passes per flat per day</label>
            <input
              className="input"
              id="policy-daily"
              type="number"
              min={1}
              max={100}
              required
              value={form.maxPassesPerFlatPerDay}
              onChange={(event) => setForm({ ...form, maxPassesPerFlatPerDay: event.target.value })}
            />
          </div>
        </div>
      </Card>

      <div className="row-end">
        <button className="btn btn-primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
      <p className="hint">Current policy: {policy.approvalCategories.length ? policy.approvalCategories.join(', ') : 'no categories need approval'} · {policy.maxPassDurationHours}h · {policy.maxUsesPerPass} entries · {policy.maxPassesPerFlatPerDay}/day.</p>
    </form>
  );
}
