'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Building2, Plus, RotateCw } from 'lucide-react';
import { Protected } from '@/components/protected';
import { AppShell, type NavItem } from '@/components/app-shell';
import { useSession } from '@/components/session-provider';
import { apiRequest } from '@/lib/api';
import type { SocietySummary } from '@/lib/types';
import { formatDate } from '@/lib/format';
import { CredentialReveal, EmptyState, Modal, Notice, errorMessage } from '@/components/ui';

const NAV: NavItem[] = [{ id: 'societies', label: 'Societies', icon: Building2 }];

interface CreateResult {
  society: { id: string; name: string; slug: string; timezone: string };
  admin: { id: string; name: string; email: string; temporaryPassword: string };
}

export default function PlatformPage() {
  return (
    <Protected roles={['PLATFORM_ADMIN']}>
      <PlatformWorkspace />
    </Protected>
  );
}

function PlatformWorkspace() {
  const { session } = useSession();
  const [societies, setSocieties] = useState<SocietySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<CreateResult | null>(null);

  async function load() {
    setLoading(true);
    try {
      const data = await apiRequest<SocietySummary[]>('/api/v1/societies');
      setSocieties(data);
      setError('');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (!session) return null;

  return (
    <AppShell
      session={session}
      societies={societies}
      nav={NAV}
      active="societies"
      onSelect={() => undefined}
    >
      <div className="content">
        <div className="page-head">
          <div>
            <h1 className="page-title">Platform societies</h1>
            <p className="page-sub">
              Onboard a tenant and issue a one-time administrator credential. Resident and gate data stays
              inside each society; platform operators do not get routine access to it.
            </p>
          </div>
          <div className="head-actions">
            <button className="btn btn-ghost" type="button" onClick={() => void load()} disabled={loading}>
              <RotateCw size={14} /> Refresh
            </button>
            <button className="btn btn-primary" type="button" onClick={() => { setCreated(null); setOpen(true); }}>
              <Plus size={15} /> New society
            </button>
          </div>
        </div>

        {error ? <Notice danger>{error}</Notice> : null}

        <div className="stat-rail" style={{ marginBottom: 18 }}>
          <div className="stat">
            <div className="stat-label">Societies</div>
            <div className="stat-value">{societies.length}</div>
            <div className="stat-note">Active tenants</div>
          </div>
          <div className="stat">
            <div className="stat-label">Buildings</div>
            <div className="stat-value">{societies.reduce((sum, item) => sum + (item._count?.buildings ?? 0), 0)}</div>
            <div className="stat-note">Across the platform</div>
          </div>
          <div className="stat">
            <div className="stat-label">Access points</div>
            <div className="stat-value">{societies.reduce((sum, item) => sum + (item._count?.accessPoints ?? 0), 0)}</div>
            <div className="stat-note">Registered gates and doors</div>
          </div>
          <div className="stat">
            <div className="stat-label">Controllers</div>
            <div className="stat-value">{societies.reduce((sum, item) => sum + (item._count?.devices ?? 0), 0)}</div>
            <div className="stat-note">Authenticated devices</div>
          </div>
          <div className="stat">
            <div className="stat-label">Your access</div>
            <div className="stat-value" style={{ fontSize: 22, marginTop: 14 }}>Metadata only</div>
            <div className="stat-note">No resident records</div>
          </div>
        </div>

        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Tenant register</h2>
            <span className="tiny muted">Platform metadata only</span>
          </div>
          {societies.length === 0 && !loading ? (
            <EmptyState
              title="No societies yet"
              copy="Create the first tenant and hand its administrator a one-time credential."
              action={<button className="btn btn-primary" type="button" onClick={() => setOpen(true)}><Plus size={15} /> New society</button>}
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Society</th>
                    <th>Timezone</th>
                    <th>Buildings</th>
                    <th>Gates</th>
                    <th>Controllers</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {societies.map((society) => (
                    <tr key={society.id}>
                      <td>
                        <div className="cell-main">{society.name}</div>
                        <div className="cell-sub">{society.slug}</div>
                      </td>
                      <td>{society.timezone}</td>
                      <td className="mono">{society._count?.buildings ?? 0}</td>
                      <td className="mono">{society._count?.accessPoints ?? 0}</td>
                      <td className="mono">{society._count?.devices ?? 0}</td>
                      <td className="muted small">{society.createdAt ? formatDate(society.createdAt) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {open ? (
        <CreateSocietyModal
          onClose={() => setOpen(false)}
          onCreated={(result) => {
            setOpen(false);
            setCreated(result);
            void load();
          }}
        />
      ) : null}

      {created ? (
        <Modal
          title="Society created"
          onClose={() => setCreated(null)}
          footer={<button className="btn btn-primary" type="button" onClick={() => setCreated(null)}>Done</button>}
        >
          <div className="stack">
            <p>
              <strong>{created.society.name}</strong> is ready. Share the administrator credential securely.
              They must change it at first sign-in.
            </p>
            <CredentialReveal
              rows={[
                { label: 'Admin email', value: created.admin.email },
                { label: 'Temporary password', value: created.admin.temporaryPassword },
              ]}
              note="This password is displayed once. It is stored only as a bcrypt hash and cannot be recovered."
            />
          </div>
        </Modal>
      ) : null}
    </AppShell>
  );
}

function CreateSocietyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (result: CreateResult) => void }) {
  const [form, setForm] = useState({
    name: '',
    slug: '',
    timezone: 'Asia/Kolkata',
    adminName: '',
    adminEmail: '',
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function update(key: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    if (key === 'name' && !form.slug) {
      const slug = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      setForm((current) => ({ ...current, name: value, slug }));
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await apiRequest<CreateResult>('/api/v1/societies', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          slug: form.slug,
          timezone: form.timezone,
          adminName: form.adminName,
          adminEmail: form.adminEmail,
        }),
      });
      onCreated(result);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="Onboard a society"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="create-society" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create society'}
          </button>
        </>
      }
    >
      <form id="create-society" className="stack" onSubmit={submit}>
        {error ? <Notice danger>{error}</Notice> : null}
        <div className="form-grid">
          <div className="field span-2">
            <label className="label" htmlFor="society-name">Society name</label>
            <input
              className="input"
              id="society-name"
              required
              minLength={3}
              value={form.name}
              onChange={(event) => update('name', event.target.value)}
              placeholder="Palm Grove Residency"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="society-slug">URL slug</label>
            <input
              className="input"
              id="society-slug"
              required
              minLength={3}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              value={form.slug}
              onChange={(event) => update('slug', event.target.value)}
              placeholder="palm-grove"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="society-tz">Timezone</label>
            <input
              className="input"
              id="society-tz"
              required
              value={form.timezone}
              onChange={(event) => update('timezone', event.target.value)}
              placeholder="Asia/Kolkata"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="admin-name">Administrator name</label>
            <input
              className="input"
              id="admin-name"
              required
              minLength={2}
              value={form.adminName}
              onChange={(event) => update('adminName', event.target.value)}
              placeholder="Ananya Rao"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="admin-email">Administrator email</label>
            <input
              className="input"
              id="admin-email"
              type="email"
              required
              value={form.adminEmail}
              onChange={(event) => update('adminEmail', event.target.value)}
              placeholder="admin@society.dev"
            />
          </div>
        </div>
        <p className="hint">
          A new account is created with a temporary password shown once. Existing accounts cannot be elevated
          through society onboarding.
        </p>
      </form>
    </Modal>
  );
}
