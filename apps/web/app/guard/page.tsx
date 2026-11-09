'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Activity,
  Ban,
  Check,
  Cpu,
  Fingerprint,
  KeyRound,
  RefreshCw,
  ScanLine,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Ticket,
} from 'lucide-react';
import { apiRequest } from '@/lib/api';
import { fetchAllPasses } from '@/lib/passes';
import type {
  AccessEvent,
  AccessPoint,
  Device,
  GateCommand,
  Overview,
  PassView,
  SocietySummary,
  VerifyResponse,
} from '@/lib/types';
import {
  categoryLabel,
  formatDateTime,
  formatWindow,
  reasonLabel,
  relativeTime,
  titleCase,
} from '@/lib/format';
import { societyList, useSession } from '@/components/session-provider';
import { Protected } from '@/components/protected';
import { AppShell, type NavItem } from '@/components/app-shell';
import {
  Badge,
  DecisionBadge,
  EmptyState,
  PassBadge,
  ReasonText,
  Toast,
  errorMessage,
} from '@/components/ui';
import { GateVisualizer, type VisualGateState } from '@/components/gate-visualizer';
import { playAuthorizedChime, playDeniedBuzzer, playEmergencyPulse } from '@/lib/sound';

const NAV: NavItem[] = [
  { id: 'console', label: 'Guard console', icon: ShieldCheck },
  { id: 'visitors', label: 'Visitor search', icon: Ticket },
  { id: 'log', label: 'Entry log', icon: ScrollText },
];

interface GuardData {
  overview: Overview | null;
  accessPoints: AccessPoint[];
  devices: Device[];
  events: AccessEvent[];
  commands: GateCommand[];
  passes: PassView[];
}

const EMPTY: GuardData = {
  overview: null,
  accessPoints: [],
  devices: [],
  events: [],
  commands: [],
  passes: [],
};



export default function GuardPage() {
  return (
    <Protected roles={['GUARD', 'SOCIETY_ADMIN']}>
      <GuardWorkspace />
    </Protected>
  );
}

function GuardWorkspace() {
  const { session } = useSession();
  const [societyId, setSocietyId] = useState('');
  const [tab, setTab] = useState('console');
  const [data, setData] = useState<GuardData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const [passQuery, setPassQuery] = useState('');
  const [passStatus, setPassStatus] = useState('');
  const toastTimer = useRef<number | null>(null);

  const societies = useMemo<SocietySummary[]>(
    () =>
      societyList(session).filter(
        (society) => society.role === 'GUARD' || society.role === 'SOCIETY_ADMIN',
      ),
    [session],
  );

  useEffect(() => {
    if (!societies.length) return;
    if (!societies.some((society) => society.id === societyId)) {
      setSocietyId(societies[0].id);
    }
  }, [societies, societyId]);

  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);

  const reload = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    if (!societyId) return;
    let active = true;
    setLoading(true);
    setLoadError('');
    const base = `/api/v1/societies/${societyId}`;
    Promise.all([
      apiRequest<Overview>(`${base}/overview`),
      apiRequest<AccessPoint[]>(`${base}/access-points`),
      apiRequest<Device[]>(`${base}/devices`),
      apiRequest<AccessEvent[]>(`${base}/access-events?limit=120`),
      apiRequest<GateCommand[]>(`${base}/gate-commands?limit=40`),
      fetchAllPasses(societyId),
    ])
      .then(([overview, accessPoints, devices, events, commands, passes]) => {
        if (!active) return;
        setData({ overview, accessPoints, devices, events, commands, passes });
      })
      .catch((caught) => {
        if (active) setLoadError(errorMessage(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [societyId, refreshKey]);

  useEffect(() => {
    if (!societyId) return;
    const timer = window.setInterval(() => {
      apiRequest<AccessEvent[]>(`/api/v1/societies/${societyId}/access-events?limit=120`)
        .then((events) => setData((current) => ({ ...current, events })))
        .catch(() => undefined);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [societyId]);

  const activeSociety = societies.find((society) => society.id === societyId);
  const timezone = activeSociety?.timezone || 'Asia/Kolkata';

  const filteredPasses = useMemo(() => {
    const query = passQuery.trim().toLowerCase();
    return data.passes.filter((pass) => {
      if (passStatus && pass.effectiveStatus !== passStatus) return false;
      if (!query) return true;
      return `${pass.visitor.name} ${pass.visitor.phone ?? ''} ${pass.flat.building} ${pass.flat.flatNumber} ${pass.host.name}`
        .toLowerCase()
        .includes(query);
    });
  }, [data.passes, passQuery, passStatus]);

  const pending = data.passes.filter((pass) => pass.effectiveStatus === 'PENDING_APPROVAL');
  const expected = data.passes.filter((pass) =>
    ['ACTIVE', 'SCHEDULED'].includes(pass.effectiveStatus),
  );

  async function passAction(pass: PassView, action: 'approve' | 'revoke') {
    if (
      action === 'revoke' &&
      !window.confirm(`Revoke the pass for ${pass.visitor.name}? This cannot be undone.`)
    ) {
      return;
    }
    setBusyKey(`pass:${pass.id}`);
    setActionError('');
    try {
      await apiRequest(`/api/v1/visitor-passes/${pass.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify(
          action === 'approve'
            ? { decision: 'APPROVED', reason: 'Approved at the guard console' }
            : { reason: 'Revoked at the guard console' },
        ),
      });
      notify(action === 'approve' ? 'Visitor pass approved' : 'Visitor pass revoked');
      reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyKey(null);
    }
  }

  if (!session) return null;

  if (!societies.length) {
    return (
      <div className="login-panel" style={{ minHeight: '100dvh' }}>
        <h1 className="login-form-title">No guard assignment</h1>
        <p className="login-form-sub">
          Your account has no active guard role. Ask a society administrator to add you to the security
          team.
        </p>
      </div>
    );
  }

  return (
    <AppShell
      session={session}
      societies={societies}
      activeSocietyId={societyId}
      onSocietyChange={(id) => {
        setSocietyId(id);
        setTab('console');
      }}
      nav={NAV}
      active={tab}
      onSelect={setTab}
    >
      <main className="content">
        <div className="page-head">
          <div>
            <div className="context-label">{activeSociety?.name}</div>
            <h1 className="page-title">
              {tab === 'console' ? 'Guard console' : tab === 'visitors' ? 'Visitor search' : 'Entry log'}
            </h1>
            <p className="page-sub">
              {tab === 'console'
                ? 'Verify a visitor credential, watch the gates and clear the approval queue.'
                : tab === 'visitors'
                  ? 'Find an expected visitor by name, phone, flat or host. Pass credentials are never exposed here.'
                  : 'An append-only record of every gate decision, with the reason code and the controller that reported it.'}
            </p>
          </div>
          <div className="head-actions">
            <button className="btn" type="button" onClick={reload} disabled={loading}>
              <RefreshCw size={14} /> Refresh
            </button>
            <a className="btn btn-primary" href="/kiosk">
              <ScanLine size={14} /> Open kiosk
            </a>
          </div>
        </div>

        {loadError ? (
          <div className="notice danger" style={{ marginBottom: 18 }}>
            {loadError}
          </div>
        ) : null}
        {actionError ? (
          <div className="notice danger" style={{ marginBottom: 18 }}>
            {actionError}
            <button
              className="btn-ghost btn-small"
              type="button"
              style={{ marginLeft: 'auto' }}
              onClick={() => setActionError('')}
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {tab === 'console' ? (
          <ConsoleTab
            data={data}
            loading={loading}
            pending={pending}
            expected={expected}
            timezone={timezone}
            busyKey={busyKey}
            onPassAction={passAction}
            onVerified={reload}
            notify={notify}
          />
        ) : tab === 'visitors' ? (
          <VisitorsTab
            passes={filteredPasses}
            total={data.passes.length}
            query={passQuery}
            status={passStatus}
            onQuery={setPassQuery}
            onStatus={setPassStatus}
            onAction={passAction}
            busyKey={busyKey}
            timezone={timezone}
          />
        ) : (
          <LogTab
            events={data.events}
            commands={data.commands}
            accessPoints={data.accessPoints}
            timezone={timezone}
          />
        )}
      </main>

      {toast ? <Toast message={toast.message} error={toast.error} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}

function ConsoleTab({
  data,
  loading,
  pending,
  expected,
  timezone,
  busyKey,
  onPassAction,
  onVerified,
  notify,
}: {
  data: GuardData;
  loading: boolean;
  pending: PassView[];
  expected: PassView[];
  timezone: string;
  busyKey: string | null;
  onPassAction: (pass: PassView, action: 'approve' | 'revoke') => void;
  onVerified: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const counts = data.overview?.counts;
  const primaryGate = data.accessPoints[0];
  const [gateVisualState, setGateVisualState] = useState<VisualGateState>('CLOSED');
  const [emergencyActive, setEmergencyActive] = useState(false);
  const gateTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearGateTimers = useCallback(() => {
    gateTimersRef.current.forEach((t) => clearTimeout(t));
    gateTimersRef.current = [];
  }, []);

  useEffect(() => {
    return () => clearGateTimers();
  }, [clearGateTimers]);

  const scheduleGateSequence = useCallback(
    (steps: { delay: number; state: VisualGateState }[]) => {
      clearGateTimers();
      for (const step of steps) {
        const timer = setTimeout(() => {
          setGateVisualState(step.state);
        }, step.delay);
        gateTimersRef.current.push(timer);
      }
    },
    [clearGateTimers],
  );

  function handleOpenPulse() {
    if (emergencyActive) return;
    clearGateTimers();
    setGateVisualState('OPENING');
    playAuthorizedChime();
    notify('Gate opened for 10-second pulse');
    scheduleGateSequence([
      { delay: 500, state: 'OPEN' },
      { delay: 8000, state: 'CLOSING' },
      { delay: 10000, state: 'CLOSED' },
    ]);
  }

  // Gate state on screen must reflect what the server accepted: if the command
  // fails, the guard has to know the barrier may NOT have moved.
  async function sendGateCommand(path: '/api/v1/access/emergency-override' | '/api/v1/access/emergency-reset', reason: string): Promise<boolean> {
    if (!primaryGate?.id) {
      notify('No gate is configured for this society', true);
      return false;
    }
    try {
      await apiRequest(path, {
        method: 'POST',
        body: JSON.stringify({ accessPointId: primaryGate.id, reason }),
      });
      return true;
    } catch (caught) {
      notify(`Gate command failed: ${errorMessage(caught)}. Operate the barrier manually.`, true);
      return false;
    }
  }

  async function activateEmergencyHold() {
    if (!window.confirm('WARNING: Activate emergency fire / egress hold? The barrier will remain open until reset.')) {
      return;
    }
    playEmergencyPulse();
    setEmergencyActive(true);
    setGateVisualState('OPEN');
    if (await sendGateCommand('/api/v1/access/emergency-override', 'Security guard initiated emergency egress hold')) {
      notify('EMERGENCY EGRESS / FIRE RELEASE ACTIVE', true);
    } else {
      setEmergencyActive(false);
      setGateVisualState('CLOSED');
    }
  }

  async function releaseEmergencyHold(reason: string) {
    if (await sendGateCommand('/api/v1/access/emergency-reset', reason)) {
      setEmergencyActive(false);
      setGateVisualState('CLOSED');
      notify('Emergency hold released. Normal access restored.');
    }
  }

  function handleEmergencyHold() {
    clearGateTimers();
    if (emergencyActive) void releaseEmergencyHold('Security guard released emergency hold');
    else void activateEmergencyHold();
  }

  return (
    <>
      <div className="stat-rail">
        <div className="stat">
          <div className="stat-label">Gates online</div>
          <div className="stat-value">
            {counts ? `${counts.onlineDevices}/${counts.devices}` : '—'}
          </div>
          <div className="stat-note">heartbeat within 2 minutes</div>
        </div>
        <div className="stat">
          <div className="stat-label">Expected today</div>
          <div className="stat-value">{expected.length}</div>
          <div className="stat-note">active and scheduled passes</div>
        </div>
        <div className="stat">
          <div className="stat-label">Awaiting approval</div>
          <div className="stat-value">{pending.length}</div>
          <div className="stat-note">verify policy before allowing</div>
        </div>
        <div className="stat">
          <div className="stat-label">Denied · 24h</div>
          <div className="stat-value">{counts?.deniedToday ?? '—'}</div>
          <div className="stat-note">{counts ? `${counts.allowedToday} allowed` : 'loading'}</div>
        </div>
      </div>

      {/* Live Physical Barrier Status & Emergency Controls */}
      <div style={{ marginTop: 18 }}>
        <GateVisualizer
          state={gateVisualState}
          type={primaryGate?.type || 'BOOM_BARRIER'}
          name={primaryGate?.name || 'Main Society Barrier'}
          location={primaryGate?.location}
          emergencyActive={emergencyActive}
          interactive
          onOpenPulse={handleOpenPulse}
          onEmergencyHold={handleEmergencyHold}
          onResetGate={() => {
            clearGateTimers();
            if (emergencyActive) {
              void releaseEmergencyHold('Security guard reset gate state');
            } else {
              setGateVisualState('CLOSED');
            }
          }}
        />
      </div>

      <section className="section-gap split">
        <VerifyPanel
          accessPoints={data.accessPoints}
          onVerified={() => {
            if (!emergencyActive) {
              clearGateTimers();
              setGateVisualState('OPENING');
              scheduleGateSequence([
                { delay: 500, state: 'OPEN' },
                { delay: 5000, state: 'CLOSING' },
                { delay: 7000, state: 'CLOSED' },
              ]);
            }
            onVerified();
          }}
          notify={notify}
        />
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Gate controllers</h2>
            <span className="small muted">
              <span className="live-dot amber" /> live telemetry
            </span>
          </div>
          {data.devices.length ? (
            <div className="timeline">
              {data.devices.map((device) => {
                const online =
                  device.status === 'ACTIVE' &&
                  device.lastSeenAt &&
                  Date.now() - new Date(device.lastSeenAt).getTime() < 120_000;
                return (
                  <div className="timeline-row" key={device.id}>
                    <Cpu size={16} strokeWidth={1.7} />
                    <div className="timeline-main">
                      <div className="timeline-title">{device.name}</div>
                      <div className="timeline-sub">
                        {device.accessPoints.map((gate) => gate.name).join(', ') || 'No gate assigned'} ·{' '}
                        {relativeTime(device.lastSeenAt)}
                      </div>
                    </div>
                    <Badge tone={online ? 'online' : device.status === 'ACTIVE' ? 'warning' : 'disabled'}>
                      {device.status !== 'ACTIVE' ? 'Disabled' : online ? 'Online' : 'Stale'}
                    </Badge>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState title="No controllers" copy="A society administrator must provision a gate controller." />
          )}
        </div>
      </section>

      <section className="section-gap split">
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Recent decisions</h2>
            <span className="small muted">{data.events.length} recorded</span>
          </div>
          {data.events.length ? (
            <div className="timeline">
              {data.events.slice(0, 10).map((event) => (
                <div className="timeline-row" key={event.id}>
                  <div className="timeline-time">{relativeTime(event.requestedAt)}</div>
                  <div className="timeline-main">
                    <div className="timeline-title">
                      {event.pass?.visitor.name ?? 'Unidentified credential'}
                    </div>
                    <div className="timeline-sub">
                      {event.accessPoint?.name ?? 'Unknown gate'}
                      {event.pass ? ` · ${event.pass.flat.flatNumber}` : ''} ·{' '}
                      <ReasonText code={event.reasonCode} />
                    </div>
                  </div>
                  <DecisionBadge decision={event.decision} />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No decisions yet" copy="Verify a credential to create the first entry." />
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Approval queue</h2>
            <span className="small muted">{pending.length} waiting</span>
          </div>
          {pending.length ? (
            <div className="timeline">
              {pending.map((pass) => (
                <div className="timeline-row" key={pass.id}>
                  <div className="timeline-main">
                    <div className="timeline-title">{pass.visitor.name}</div>
                    <div className="timeline-sub">
                      {categoryLabel(pass.category)} · {pass.flat.building} {pass.flat.flatNumber} ·{' '}
                      {formatWindow(pass.validFrom, pass.validUntil, timezone)}
                    </div>
                  </div>
                  <button
                    className="btn btn-small btn-primary"
                    type="button"
                    disabled={busyKey === `pass:${pass.id}`}
                    onClick={() => onPassAction(pass, 'approve')}
                  >
                    <Check size={13} /> Approve
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="Queue clear" copy="No visitor pass needs a decision right now." />
          )}
          {loading && !data.overview ? <div className="skeleton-block" /> : null}
        </div>
      </section>
    </>
  );
}

function VerifyPanel({
  accessPoints,
  onVerified,
  notify,
}: {
  accessPoints: AccessPoint[];
  onVerified: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [accessPointId, setAccessPointId] = useState('');
  const [credentialType, setCredentialType] = useState<'PIN' | 'QR'>('PIN');
  const [credential, setCredential] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<VerifyResponse | null>(null);

  useEffect(() => {
    if (!accessPoints.length) return;
    if (!accessPoints.some((gate) => gate.id === accessPointId)) {
      setAccessPointId(accessPoints[0].id);
    }
  }, [accessPoints, accessPointId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setResult(null);
    if (!accessPointId) return setError('Select a gate.');
    if (credential.trim().length < 4) return setError('Enter the visitor credential.');
    setSubmitting(true);
    try {
      const response = await apiRequest<VerifyResponse>('/api/v1/access/manual-verify', {
        method: 'POST',
        body: JSON.stringify({
          accessPointId,
          credentialType,
          credential: credential.trim(),
        }),
      });
      setResult(response);
      setCredential('');
      if (response.decision === 'AUTHORIZED') {
        playAuthorizedChime();
        notify('Visitor authorized');
      } else {
        playDeniedBuzzer();
      }
      onVerified();
    } catch (caught) {
      playDeniedBuzzer();
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Verify a credential</h2>
        <span className="small muted">Manual override is audited</span>
      </div>
      <div className="panel-body">
        <form className="stack" onSubmit={submit}>
          {error ? <div className="notice danger">{error}</div> : null}
          {result ? (
            <div className={`kiosk-result ${result.decision === 'AUTHORIZED' ? 'ok' : 'bad'}`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {result.decision === 'AUTHORIZED' ? (
                  <ShieldCheck size={22} />
                ) : (
                  <ShieldAlert size={22} />
                )}
                <div>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 24 }}>
                    {result.decision === 'AUTHORIZED' ? 'Entry allowed' : 'Entry denied'}
                  </div>
                  <div className="small" style={{ opacity: 0.7, marginTop: 2 }}>
                    {reasonLabel(result.reasonCode)}
                    {result.commandId ? ' · gate command issued' : ''}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          <div className="form-grid">
            <div className="field">
              <label className="label" htmlFor="verify-gate">Gate</label>
              <select
                className="select"
                id="verify-gate"
                value={accessPointId}
                onChange={(event) => setAccessPointId(event.target.value)}
                required
              >
                {accessPoints.map((gate) => (
                  <option key={gate.id} value={gate.id}>
                    {gate.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <span className="label">Credential type</span>
              <div className="tabs" style={{ marginBottom: 0 }}>
                <button
                  type="button"
                  className={`tab ${credentialType === 'PIN' ? 'active' : ''}`}
                  onClick={() => {
                    setCredentialType('PIN');
                    setCredential('');
                  }}
                >
                  <KeyRound size={13} /> PIN
                </button>
                <button
                  type="button"
                  className={`tab ${credentialType === 'QR' ? 'active' : ''}`}
                  onClick={() => {
                    setCredentialType('QR');
                    setCredential('');
                  }}
                >
                  <ScanLine size={13} /> QR token
                </button>
              </div>
            </div>
            <div className="field span-2">
              <label className="label" htmlFor="verify-credential">
                {credentialType === 'PIN' ? 'Six-digit PIN' : 'QR token'}
              </label>
              <input
                className="input"
                id="verify-credential"
                value={credential}
                onChange={(event) =>
                  setCredential(
                    credentialType === 'PIN'
                      ? event.target.value.replace(/\D/g, '').slice(0, 6)
                      : event.target.value.trim(),
                  )
                }
                inputMode={credentialType === 'PIN' ? 'numeric' : 'text'}
                autoComplete="off"
                placeholder={credentialType === 'PIN' ? '••••••' : 'Paste the token from the visitor QR'}
                maxLength={credentialType === 'PIN' ? 6 : 64}
                required
              />
              <p className="hint">
                {credentialType === 'PIN'
                  ? 'The PIN is printed on the visitor invitation. It is single-use per entry.'
                  : 'Scanning the visitor QR yields the token. Never store or share it.'}
              </p>
            </div>
          </div>
          <div className="row-end">
            <a className="btn" href="/kiosk">
              <Fingerprint size={14} /> Kiosk mode
            </a>
            <button className="btn btn-primary" type="submit" disabled={submitting || !accessPoints.length}>
              <ShieldCheck size={14} /> {submitting ? 'Checking…' : 'Verify at gate'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function VisitorsTab({
  passes,
  total,
  query,
  status,
  onQuery,
  onStatus,
  onAction,
  busyKey,
  timezone,
}: {
  passes: PassView[];
  total: number;
  query: string;
  status: string;
  onQuery: (value: string) => void;
  onStatus: (value: string) => void;
  onAction: (pass: PassView, action: 'approve' | 'revoke') => void;
  busyKey: string | null;
  timezone: string;
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="panel-title">
          Visitor passes <span className="small muted">({total})</span>
        </h2>
        <div className="filter-row">
          <input
            className="input"
            style={{ width: 230 }}
            placeholder="Name, phone, flat or host"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            aria-label="Search visitor passes"
          />
          <select
            className="select"
            style={{ width: 170 }}
            value={status}
            onChange={(event) => onStatus(event.target.value)}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="SCHEDULED">Scheduled</option>
            <option value="PENDING_APPROVAL">Awaiting approval</option>
            <option value="EXPIRED">Expired</option>
            <option value="EXHAUSTED">Used up</option>
            <option value="REVOKED">Revoked</option>
          </select>
        </div>
      </div>
      {passes.length ? (
        passes.map((pass) => (
          <div className="pass-row" key={pass.id}>
            <div>
              <div className="pass-name">{pass.visitor.name}</div>
              <div className="pass-meta">
                {pass.visitor.phone ?? 'No phone'} · {categoryLabel(pass.category)} ·{' '}
                {pass.flat.building} {pass.flat.flatNumber} · host {pass.host.name}
              </div>
            </div>
            <div className="pass-window">
              {formatWindow(pass.validFrom, pass.validUntil, timezone)}
              <div className="pass-meta">
                {pass.usedCount} of {pass.maxUses} entries ·{' '}
                {pass.accessPoints.map((gate) => gate.name).join(', ') || 'No gate'}
              </div>
            </div>
            <PassBadge status={pass.effectiveStatus} />
            <div className="pass-actions">
              {pass.effectiveStatus === 'PENDING_APPROVAL' ? (
                <button
                  className="btn btn-small btn-primary"
                  type="button"
                  disabled={busyKey === `pass:${pass.id}`}
                  onClick={() => onAction(pass, 'approve')}
                >
                  <Check size={13} /> Approve
                </button>
              ) : null}
              {['ACTIVE', 'SCHEDULED', 'PENDING_APPROVAL'].includes(pass.effectiveStatus) ? (
                <button
                  className="btn btn-small btn-danger"
                  type="button"
                  disabled={busyKey === `pass:${pass.id}`}
                  onClick={() => onAction(pass, 'revoke')}
                >
                  <Ban size={13} /> Revoke
                </button>
              ) : null}
            </div>
          </div>
        ))
      ) : (
        <EmptyState
          title={total ? 'No passes match' : 'No visitor passes'}
          copy={
            total
              ? 'Try a different name, flat or status.'
              : 'Residents issue passes from their own workspace; they will appear here immediately.'
          }
        />
      )}
    </div>
  );
}

function LogTab({
  events,
  commands,
  accessPoints,
  timezone,
}: {
  events: AccessEvent[];
  commands: GateCommand[];
  accessPoints: AccessPoint[];
  timezone: string;
}) {
  const [gateId, setGateId] = useState('');
  const filtered = gateId ? events.filter((event) => event.accessPointId === gateId) : events;
  const [showCommands, setShowCommands] = useState(false);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-title">
            Access decisions <span className="small muted">({filtered.length})</span>
          </h2>
          <div className="filter-row">
            <select
              className="select"
              style={{ width: 190 }}
              value={gateId}
              onChange={(event) => setGateId(event.target.value)}
              aria-label="Filter by gate"
            >
              <option value="">All gates</option>
              {accessPoints.map((gate) => (
                <option key={gate.id} value={gate.id}>
                  {gate.name}
                </option>
              ))}
            </select>
            <button className="btn btn-small" type="button" onClick={() => setShowCommands((value) => !value)}>
              <Activity size={13} /> {showCommands ? 'Hide commands' : 'Gate commands'}
            </button>
          </div>
        </div>
        {filtered.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Visitor</th>
                  <th>Gate</th>
                  <th>Credential</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((event) => (
                  <tr key={event.id}>
                    <td className="small">{formatDateTime(event.requestedAt, timezone)}</td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{event.pass?.visitor.name ?? 'Unknown'}</div>
                      <div className="tiny muted">
                        {event.pass ? `Flat ${event.pass.flat.flatNumber}` : 'No linked pass'}
                      </div>
                    </td>
                    <td className="small">{event.accessPoint?.name ?? '—'}</td>
                    <td className="small">
                      {event.credentialType ?? '—'}
                      <div className="tiny muted">{titleCase(event.source)}</div>
                    </td>
                    <td>
                      <DecisionBadge decision={event.decision} />
                      <div style={{ marginTop: 4 }}>
                        <ReasonText code={event.reasonCode} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No access decisions" copy="Nothing has hit a gate with this filter yet." />
        )}
      </div>

      {showCommands ? (
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Gate commands</h2>
            <span className="small muted">signed, expiring at 30 seconds</span>
          </div>
          {commands.length ? (
            <div className="timeline">
              {commands.map((command) => (
                <div className="timeline-row" key={command.id}>
                  <div className="timeline-time">{relativeTime(command.issuedAt)}</div>
                  <div className="timeline-main">
                    <div className="timeline-title">
                      {command.type} · {command.accessPoint.name}
                    </div>
                    <div className="timeline-sub">
                      {command.device.name} · issued {formatDateTime(command.issuedAt, timezone)}
                      {command.executedAt ? ` · executed ${formatDateTime(command.executedAt, timezone)}` : ''}
                    </div>
                  </div>
                  <Badge tone={command.status === 'EXECUTED' ? 'authorized' : command.status === 'FAILED' || command.status === 'EXPIRED' ? 'denied' : 'warning'}>
                    {titleCase(command.status)}
                  </Badge>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No gate commands" copy="An authorized credential will create a signed open command." />
          )}
        </div>
      ) : null}
    </div>
  );
}
