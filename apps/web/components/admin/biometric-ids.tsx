'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '@/lib/api';
import type { BiometricIdentity, Resident } from '@/lib/types';
import { Badge, EmptyState, Notice, errorMessage } from '../ui';

const DEVICE_USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export function BiometricIdentities({ societyId, residents }: { societyId: string; residents: Resident[] }) {
  const [identities, setIdentities] = useState<BiometricIdentity[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [requested, setRequested] = useState<Record<string, string>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const base = `/api/v1/societies/${societyId}/biometric-identities`;

  useEffect(() => {
    if (!societyId) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    apiRequest<BiometricIdentity[]>(base, { signal: controller.signal })
      .then((rows) => setIdentities(rows))
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(errorMessage(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [base, societyId, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  const byUser = new Map(identities.map((identity) => [identity.userId, identity]));

  async function assign(resident: Resident): Promise<void> {
    const deviceUserId = (requested[resident.userId] ?? '').trim();
    if (deviceUserId && !DEVICE_USER_ID_PATTERN.test(deviceUserId)) {
      setActionError('Terminal ID must be 1-32 letters, digits, - or _.');
      return;
    }
    setBusyId(resident.userId);
    setActionError('');
    try {
      await apiRequest<BiometricIdentity>(base, {
        method: 'POST',
        body: JSON.stringify({ userId: resident.userId, ...(deviceUserId ? { deviceUserId } : {}) }),
      });
      setRequested((current) => ({ ...current, [resident.userId]: '' }));
      reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(resident: Resident, identity: BiometricIdentity): Promise<void> {
    if (!window.confirm(`Revoke terminal ID ${identity.deviceUserId} for ${resident.name}? Their fingerprint and face stop opening the gate.`)) return;
    setBusyId(resident.userId);
    setActionError('');
    try {
      await apiRequest(`${base}/${identity.id}`, { method: 'DELETE' });
      reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="panel" style={{ marginTop: 16 }} aria-labelledby="biometric-ids-title">
      <div className="panel-head">
        <h2 className="panel-title" id="biometric-ids-title">Biometric terminal IDs</h2>
      </div>
      <p className="hint">
        Fingerprints and faces are enrolled at the terminal against this ID. SocietyOS never stores them.
      </p>
      {actionError ? <Notice danger>{actionError}</Notice> : null}
      {loadError ? (
        <Notice danger>
          {loadError}{' '}
          <button className="btn btn-small" type="button" onClick={reload}>Retry</button>
        </Notice>
      ) : loading && !identities.length ? (
        <p className="hint" role="status">Loading terminal IDs…</p>
      ) : residents.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Resident</th>
                <th>Terminal user ID</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {residents.map((resident) => {
                const identity = byUser.get(resident.userId);
                const active = identity !== undefined && identity.revokedAt === null;
                const busy = busyId === resident.userId;
                return (
                  <tr key={resident.userId}>
                    <td>{resident.name}</td>
                    <td>{identity ? <code>{identity.deviceUserId}</code> : <span className="small muted">Not assigned</span>}</td>
                    <td>
                      {identity ? (
                        <Badge tone={active ? 'active' : 'disabled'}>{active ? 'Active' : 'Revoked'}</Badge>
                      ) : (
                        <span className="small muted">-</span>
                      )}
                    </td>
                    <td>
                      {active ? (
                        <button
                          className="btn btn-ghost btn-small"
                          type="button"
                          disabled={busy}
                          aria-label={`Revoke terminal ID for ${resident.name}`}
                          onClick={() => void revoke(resident, identity)}
                        >
                          Revoke
                        </button>
                      ) : (
                        <div className="head-actions" style={{ justifyContent: 'flex-start' }}>
                          {identity ? null : (
                            <input
                              className="input"
                              style={{ maxWidth: 150 }}
                              maxLength={32}
                              value={requested[resident.userId] ?? ''}
                              onChange={(event) => setRequested((current) => ({ ...current, [resident.userId]: event.target.value }))}
                              placeholder="Existing ID (optional)"
                              aria-label={`Existing terminal ID for ${resident.name} (optional)`}
                            />
                          )}
                          <button
                            className="btn btn-small"
                            type="button"
                            disabled={busy}
                            aria-label={`${identity ? 'Re-assign' : 'Assign'} terminal ID for ${resident.name}`}
                            onClick={() => void assign(resident)}
                          >
                            {identity ? 'Re-assign' : 'Assign ID'}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No residents to assign" copy="Add residents to a flat first, then give each a terminal user ID." />
      )}
    </div>
  );
}
