'use client';

import { useState, type FormEvent } from 'react';
import { apiRequest } from '@/lib/api';
import type {
  AccessPoint,
  Building,
  DeviceProvisionResult,
  FlatOption,
  PassWithCredentials,
} from '@/lib/types';
import { Modal, Notice, errorMessage } from '../ui';
import { PassForm } from '../pass-form';

export interface CredentialInfo {
  title: string;
  rows: { label: string; value: string }[];
  note?: string;
}

type Done = (credentials?: CredentialInfo) => void;

function ErrorBox({ error }: { error: string }) {
  return error ? <Notice danger>{error}</Notice> : null;
}

export function AddBuildingModal({
  societyId,
  onClose,
  onDone,
}: {
  societyId: string;
  onClose: () => void;
  onDone: Done;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await apiRequest(`/api/v1/societies/${societyId}/buildings`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="Add a building"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="add-building" disabled={submitting}>
            {submitting ? 'Adding…' : 'Add building'}
          </button>
        </>
      }
    >
      <form id="add-building" className="stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="field">
          <label className="label" htmlFor="building-name">Building name</label>
          <input
            className="input"
            id="building-name"
            required
            minLength={1}
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Tower C"
          />
        </div>
      </form>
    </Modal>
  );
}

export function AddFlatModal({
  buildings,
  onClose,
  onDone,
}: {
  buildings: Building[];
  onClose: () => void;
  onDone: Done;
}) {
  const [buildingId, setBuildingId] = useState(buildings[0]?.id ?? '');
  const [flatNumber, setFlatNumber] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await apiRequest(`/api/v1/buildings/${buildingId}/flats`, {
        method: 'POST',
        body: JSON.stringify({ flatNumber }),
      });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="Add a flat"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="add-flat" disabled={submitting || !buildingId}>
            {submitting ? 'Adding…' : 'Add flat'}
          </button>
        </>
      }
    >
      <form id="add-flat" className="stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <div className="field">
            <label className="label" htmlFor="flat-building">Building</label>
            <select className="select" id="flat-building" value={buildingId} onChange={(event) => setBuildingId(event.target.value)}>
              {buildings.map((building) => (
                <option key={building.id} value={building.id}>{building.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="flat-number">Flat number</label>
            <input
              className="input"
              id="flat-number"
              required
              maxLength={20}
              value={flatNumber}
              onChange={(event) => setFlatNumber(event.target.value)}
              placeholder="C-1201"
            />
          </div>
        </div>
      </form>
    </Modal>
  );
}

export function AddResidentModal({
  societyId,
  flats,
  onClose,
  onDone,
}: {
  societyId: string;
  flats: FlatOption[];
  onClose: () => void;
  onDone: Done;
}) {
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    flatId: flats[0]?.id ?? '',
    relationship: 'OWNER',
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const result = await apiRequest<{
        user: { email: string };
        temporaryPassword: string | null;
      }>(`/api/v1/societies/${societyId}/residents`, {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          ...(form.phone ? { phone: form.phone } : {}),
          flatId: form.flatId,
          relationship: form.relationship,
        }),
      });
      onDone(
        result.temporaryPassword
          ? {
              title: 'Resident account created',
              rows: [
                { label: 'Email', value: form.email },
                { label: 'Temporary password', value: result.temporaryPassword },
              ],
              note: 'The resident must change this password at first sign-in. It is shown once.',
            }
          : {
              title: 'Existing account linked',
              rows: [{ label: 'Email', value: form.email }],
              note: 'This person already had a SocietyOS account, so no new password was issued.',
            },
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="Add a resident"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="add-resident" disabled={submitting || !form.flatId}>
            {submitting ? 'Adding…' : 'Add resident'}
          </button>
        </>
      }
    >
      <form id="add-resident" className="stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <div className="field">
            <label className="label" htmlFor="resident-name">Full name</label>
            <input className="input" id="resident-name" required minLength={2} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </div>
          <div className="field">
            <label className="label" htmlFor="resident-email">Email</label>
            <input className="input" id="resident-email" type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </div>
          <div className="field">
            <label className="label" htmlFor="resident-phone">Phone (optional)</label>
            <input className="input" id="resident-phone" maxLength={20} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
          </div>
          <div className="field">
            <label className="label" htmlFor="resident-flat">Flat</label>
            <select className="select" id="resident-flat" required value={form.flatId} onChange={(event) => setForm({ ...form, flatId: event.target.value })}>
              {flats.map((flat) => <option key={flat.id} value={flat.id}>{flat.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="resident-relationship">Relationship</label>
            <select className="select" id="resident-relationship" value={form.relationship} onChange={(event) => setForm({ ...form, relationship: event.target.value })}>
              <option value="OWNER">Owner</option>
              <option value="TENANT">Tenant</option>
              <option value="FAMILY">Family member</option>
            </select>
          </div>
        </div>
        <p className="hint">New accounts receive a one-time temporary password and must replace it at first sign-in.</p>
      </form>
    </Modal>
  );
}

export function AddGuardModal({
  societyId,
  onClose,
  onDone,
}: {
  societyId: string;
  onClose: () => void;
  onDone: Done;
}) {
  const [form, setForm] = useState({ name: '', email: '', phone: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const result = await apiRequest<{ temporaryPassword: string }>(`/api/v1/societies/${societyId}/guards`, {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          ...(form.phone ? { phone: form.phone } : {}),
        }),
      });
      onDone({
        title: 'Guard account created',
        rows: [
          { label: 'Email', value: form.email },
          { label: 'Temporary password', value: result.temporaryPassword },
        ],
        note: 'The guard must change this password at first sign-in.',
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="Add a security guard"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="add-guard" disabled={submitting}>
            {submitting ? 'Adding…' : 'Add guard'}
          </button>
        </>
      }
    >
      <form id="add-guard" className="stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <div className="field">
            <label className="label" htmlFor="guard-name">Full name</label>
            <input className="input" id="guard-name" required minLength={2} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </div>
          <div className="field">
            <label className="label" htmlFor="guard-email">Email</label>
            <input className="input" id="guard-email" type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </div>
          <div className="field">
            <label className="label" htmlFor="guard-phone">Phone (optional)</label>
            <input className="input" id="guard-phone" maxLength={20} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
          </div>
        </div>
      </form>
    </Modal>
  );
}

export function CreateAccessPointModal({
  societyId,
  onClose,
  onDone,
}: {
  societyId: string;
  onClose: () => void;
  onDone: Done;
}) {
  const [form, setForm] = useState({ name: '', type: 'BOOM_BARRIER', location: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await apiRequest(`/api/v1/societies/${societyId}/access-points`, {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          type: form.type,
          ...(form.location ? { location: form.location } : {}),
        }),
      });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="Add an access point"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="add-ap" disabled={submitting}>
            {submitting ? 'Adding…' : 'Add access point'}
          </button>
        </>
      }
    >
      <form id="add-ap" className="stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <div className="field">
            <label className="label" htmlFor="ap-name">Name</label>
            <input className="input" id="ap-name" required minLength={2} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="North Vehicle Gate" />
          </div>
          <div className="field">
            <label className="label" htmlFor="ap-type">Gate family</label>
            <select className="select" id="ap-type" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
              <option value="BOOM_BARRIER">Boom barrier</option>
              <option value="SLIDING_GATE">Sliding gate</option>
              <option value="DOOR_LOCK">Electromagnetic door lock</option>
            </select>
          </div>
          <div className="field span-2">
            <label className="label" htmlFor="ap-location">Location note</label>
            <input className="input" id="ap-location" maxLength={200} value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} placeholder="North edge, near visitor parking" />
          </div>
        </div>
        <p className="hint">Authorization is software. Physical safety interlocks, obstruction sensors and emergency release remain hardware responsibilities.</p>
      </form>
    </Modal>
  );
}

export function ProvisionDeviceModal({
  societyId,
  accessPoints,
  onClose,
  onDone,
}: {
  societyId: string;
  accessPoints: AccessPoint[];
  onClose: () => void;
  onDone: Done;
}) {
  const [form, setForm] = useState({
    name: '',
    deviceUid: '',
    firmware: '',
    accessPointIds: accessPoints[0] ? [accessPoints[0].id] : [],
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function toggle(id: string) {
    setForm((current) => ({
      ...current,
      accessPointIds: current.accessPointIds.includes(id)
        ? current.accessPointIds.filter((value) => value !== id)
        : [...current.accessPointIds, id],
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const result = await apiRequest<DeviceProvisionResult>(`/api/v1/societies/${societyId}/devices`, {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          deviceUid: form.deviceUid,
          ...(form.firmware ? { firmware: form.firmware } : {}),
          accessPointIds: form.accessPointIds,
        }),
      });
      onDone({
        title: 'Controller provisioned',
        rows: [
          { label: 'Device token', value: result.credentials.deviceToken },
          { label: 'Command secret', value: result.credentials.commandSecret },
        ],
        note: 'Store these on the controller now. The token is hashed server-side and the command secret is encrypted at rest; neither can be shown again.',
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="Provision a controller"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            type="submit"
            form="provision-device"
            disabled={submitting}
          >
            {submitting ? 'Provisioning…' : 'Provision controller'}
          </button>
        </>
      }
    >
      <form id="provision-device" className="stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <div className="field">
            <label className="label" htmlFor="device-name">Display name</label>
            <input className="input" id="device-name" required minLength={2} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="North gate controller" />
          </div>
          <div className="field">
            <label className="label" htmlFor="device-uid">Device UID</label>
            <input className="input" id="device-uid" required minLength={3} pattern="[A-Za-z0-9._:-]+" value={form.deviceUid} onChange={(event) => setForm({ ...form, deviceUid: event.target.value })} placeholder="gate-north-01" />
          </div>
          <div className="field">
            <label className="label" htmlFor="device-firmware">Firmware (optional)</label>
            <input className="input" id="device-firmware" maxLength={40} value={form.firmware} onChange={(event) => setForm({ ...form, firmware: event.target.value })} placeholder="sim-1.0.0" />
          </div>
          <div className="field span-2">
            <span className="label">Assigned access points</span>
            <div className="check-row">
              {accessPoints.map((accessPoint) => (
                <label className="check-chip" key={accessPoint.id}>
                  <input type="checkbox" checked={form.accessPointIds.includes(accessPoint.id)} onChange={() => toggle(accessPoint.id)} />
                  {accessPoint.name}
                </label>
              ))}
            </div>
          </div>
        </div>
        <p className="hint">A controller can open only the access points assigned here. Revoking a credential takes effect on the next request.</p>
      </form>
    </Modal>
  );
}

export function NewPassModal({
  flats,
  accessPoints,
  onClose,
  onCreated,
}: {
  flats: FlatOption[];
  accessPoints: AccessPoint[];
  onClose: () => void;
  onCreated: (result: PassWithCredentials) => void;
}) {
  return (
    <Modal title="Issue a visitor pass" onClose={onClose} wide>
      <PassForm flats={flats} accessPoints={accessPoints} onCreated={onCreated} />
    </Modal>
  );
}
