'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Ban,
  Bell,
  Building2,
  Check,
  Cpu,
  CreditCard,
  LayoutDashboard,
  Plus,
  RefreshCw,
  RotateCw,
  ScrollText,
  Calendar,
  Settings2,
  Shield,
  Ticket,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import {
  AdminAnnouncementsManager,
  AdminHelpdeskManager,
  AdminAmenitiesManager,
  AdminInvoicesManager,
} from '@/components/community-tabs';
import { apiRequest } from '@/lib/api';
import type {
  AccessEvent,
  AccessPoint,
  AuditLog,
  Building,
  Device,
  DeviceCredentials,
  FlatOption,
  GateCommand,
  Overview,
  PassPage,
  PassView,
  Resident,
  SecurityAlert,
  SocietySummary,
  StaffMember,
} from '@/lib/types';
import {
  categoryLabel,
  formatDateTime,
  formatWindow,
  relativeTime,
  roleLabel,
  titleCase,
} from '@/lib/format';
import { societyList, useSession } from '@/components/session-provider';
import { Protected } from '@/components/protected';
import { AppShell, type NavItem } from '@/components/app-shell';
import {
  Badge,
  CredentialReveal,
  DecisionBadge,
  EmptyState,
  Modal,
  PassBadge,
  ReasonText,
  errorMessage,
} from '@/components/ui';
import {
  AddBuildingModal,
  AddFlatModal,
  AddGuardModal,
  AddResidentModal,
  CreateAccessPointModal,
  NewPassModal,
  ProvisionDeviceModal,
  type CredentialInfo,
} from '@/components/admin/forms';
import { SocietySettings } from '@/components/admin/settings';

const NAV: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'passes', label: 'Visitor passes', icon: Ticket },
  { id: 'announcements', label: 'Circulars', icon: Bell },
  { id: 'helpdesk', label: 'Helpdesk', icon: Wrench },
  { id: 'amenities', label: 'Amenities', icon: Calendar },
  { id: 'billing', label: 'Maintenance billing', icon: CreditCard },
  { id: 'residents', label: 'Residents', icon: Users },
  { id: 'staff', label: 'Security team', icon: Shield },
  { id: 'buildings', label: 'Buildings & flats', icon: Building2 },
  { id: 'devices', label: 'Gates & devices', icon: Cpu },
  { id: 'logs', label: 'Access log', icon: ScrollText },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];

type CreateModalKind = 'building' | 'flat' | 'resident' | 'guard' | 'access-point' | 'device' | 'pass' | null;

interface AdminData {
  overview: Overview | null;
  passes: PassView[];
  residents: Resident[];
  staff: StaffMember[];
  buildings: Building[];
  accessPoints: AccessPoint[];
  devices: Device[];
  events: AccessEvent[];
  commands: GateCommand[];
  audits: AuditLog[];
  alerts: SecurityAlert[];
}

function emptyData(): AdminData {
  return {
    overview: null,
    passes: [],
    residents: [],
    staff: [],
    buildings: [],
    accessPoints: [],
    devices: [],
    events: [],
    commands: [],
    audits: [],
    alerts: [],
  };
}

function Stat({ label, value, note }: { label: string; value: number | string; note?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

export default function AdminPage() {
  return (
    <Protected roles={['SOCIETY_ADMIN']}>
      <AdminWorkspace />
    </Protected>
  );
}

function AdminWorkspace() {
  const { session } = useSession();
  const [societyId, setSocietyId] = useState('');
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState<AdminData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [createModal, setCreateModal] = useState<CreateModalKind>(null);
  const [credentials, setCredentials] = useState<CredentialInfo | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [passStatus, setPassStatus] = useState('');
  const [passQuery, setPassQuery] = useState('');
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const toastTimer = useRef<number | null>(null);

  const societies = useMemo<SocietySummary[]>(
    () => societyList(session).filter((society) => society.role === 'SOCIETY_ADMIN'),
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
      apiRequest<PassPage>(`/api/v1/visitor-passes?societyId=${societyId}&limit=100`),
      apiRequest<Resident[]>(`${base}/residents`),
      apiRequest<StaffMember[]>(`${base}/staff`),
      apiRequest<Building[]>(`${base}/buildings`),
      apiRequest<AccessPoint[]>(`${base}/access-points`),
      apiRequest<Device[]>(`${base}/devices`),
      apiRequest<AccessEvent[]>(`${base}/access-events?limit=100`),
      apiRequest<GateCommand[]>(`${base}/gate-commands?limit=50`),
      apiRequest<AuditLog[]>(`${base}/audit-logs`),
      apiRequest<SecurityAlert[]>(`${base}/security-alerts`),
    ])
      .then(([overview, passes, residents, staff, buildings, accessPoints, devices, events, commands, audits, alerts]) => {
        if (!active) return;
        setData({
          overview,
          passes: passes.items,
          residents,
          staff,
          buildings,
          accessPoints,
          devices,
          events,
          commands,
          audits,
          alerts,
        });
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

  const activeSociety = societies.find((society) => society.id === societyId);
  const timezone = activeSociety?.timezone || data.overview?.timezone || 'Asia/Kolkata';
  const flatOptions = useMemo<FlatOption[]>(
    () =>
      data.buildings.flatMap((building) =>
        building.flats.map((flat) => ({
          id: flat.id,
          label: `${building.name} · ${flat.flatNumber}`,
          building: building.name,
          flatNumber: flat.flatNumber,
        })),
      ),
    [data.buildings],
  );

  const filteredPasses = useMemo(() => {
    const query = passQuery.trim().toLowerCase();
    return data.passes.filter((pass) => {
      if (passStatus && pass.effectiveStatus !== passStatus) return false;
      if (!query) return true;
      return `${pass.visitor.name} ${pass.flat.building} ${pass.flat.flatNumber} ${pass.host.name}`
        .toLowerCase()
        .includes(query);
    });
  }, [data.passes, passStatus, passQuery]);

  const pendingPasses = data.passes.filter((pass) => pass.effectiveStatus === 'PENDING_APPROVAL');

  function finishCreate(info?: CredentialInfo) {
    setCreateModal(null);
    if (info) setCredentials(info);
    else notify('Saved');
    reload();
  }

  async function passAction(pass: PassView, action: 'approve' | 'revoke') {
    if (action === 'revoke' && !window.confirm(`Revoke the pass for ${pass.visitor.name}? The credential stops working immediately.`)) {
      return;
    }
    setBusyKey(`pass:${pass.id}`);
    setActionError('');
    try {
      await apiRequest(`/api/v1/visitor-passes/${pass.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify(action === 'approve' ? { decision: 'APPROVED' } : { reason: 'Revoked from admin console' }),
      });
      notify(action === 'approve' ? 'Pass approved' : 'Pass revoked');
      reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyKey(null);
    }
  }

  async function removeMember(userId: string, flatId: string, name: string, label: string) {
    if (!window.confirm(`End ${name}'s membership of ${label}? Their active passes for this flat are revoked.`)) return;
    setBusyKey(`member:${userId}:${flatId}`);
    setActionError('');
    try {
      await apiRequest(`/api/v1/flats/${flatId}/members/${userId}`, { method: 'DELETE' });
      notify('Membership ended');
      reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyKey(null);
    }
  }

  async function toggleDevice(device: Device) {
    const disable = device.status === 'ACTIVE';
    if (disable && !window.confirm(`Disable ${device.name}? Pending gate commands are expired and the controller can no longer authenticate.`)) {
      return;
    }
    setBusyKey(`device:${device.id}`);
    setActionError('');
    try {
      await apiRequest(`/api/v1/devices/${device.id}/${disable ? 'disable' : 'enable'}`, { method: 'POST' });
      notify(disable ? 'Controller disabled' : 'Controller enabled');
      reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyKey(null);
    }
  }

  async function rotateDevice(device: Device) {
    if (!window.confirm(`Rotate credentials for ${device.name}? The controller must be updated immediately or it will go offline.`)) return;
    setBusyKey(`rotate:${device.id}`);
    setActionError('');
    try {
      const result = await apiRequest<{ credentials: DeviceCredentials }>(
        `/api/v1/devices/${device.id}/rotate-credential`,
        { method: 'POST' },
      );
      setCredentials({
        title: 'New controller credentials',
        rows: [
          { label: 'Device token', value: result.credentials.deviceToken },
          { label: 'Command secret', value: result.credentials.commandSecret },
        ],
        note: result.credentials.note,
      });
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
        <h1 className="login-form-title">No society to administer</h1>
        <p className="login-form-sub">Your account has no active society administrator role. Ask a platform operator for access.</p>
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
        setTab('overview');
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
              {tab === 'overview' ? 'Command view' : NAV.find((item) => item.id === tab)?.label}
            </h1>
            <p className="page-sub">
              {tab === 'overview'
                ? 'Live gate state, visitor throughput and the work waiting on your desk.'
                : tab === 'passes'
                  ? 'Issue, approve and revoke visitor credentials. Credentials are shown once and stored only as keyed hashes.'
                  : tab === 'announcements'
                    ? 'Publish community circulars, maintenance outages and emergency alerts.'
                    : tab === 'helpdesk'
                      ? 'Review and assign resident service tickets and facility repairs.'
                      : tab === 'amenities'
                        ? 'Reserve and manage community clubhouses, courts, and shared halls.'
                        : tab === 'billing'
                          ? 'Generate society dues, monitor collections, and track unit invoices.'
                  : tab === 'residents'
                    ? 'The people who call this society home, and the flats they are linked to.'
                    : tab === 'staff'
                      ? 'Administrators and guards who can operate the gates.'
                      : tab === 'buildings'
                        ? 'The physical structure that passes, residents and gate policy are anchored to.'
                        : tab === 'devices'
                          ? 'Controllers, gate assignments and credential rotation.'
                          : tab === 'logs'
                            ? 'Every access decision and administrative action is append-only.'
                            : 'Policy is enforced server-side. Changes apply to new passes and approvals.'}
            </p>
          </div>
          <div className="head-actions">
            <button className="btn" type="button" onClick={reload} disabled={loading}>
              <RefreshCw size={14} /> Refresh
            </button>
            {tab === 'passes' ? (
              <button className="btn btn-primary" type="button" onClick={() => setCreateModal('pass')}>
                <Plus size={14} /> New pass
              </button>
            ) : null}
            {tab === 'residents' ? (
              <button className="btn btn-primary" type="button" onClick={() => setCreateModal('resident')}>
                <Plus size={14} /> Add resident
              </button>
            ) : null}
            {tab === 'staff' ? (
              <button className="btn btn-primary" type="button" onClick={() => setCreateModal('guard')}>
                <Plus size={14} /> Add guard
              </button>
            ) : null}
            {tab === 'buildings' ? (
              <>
                <button className="btn" type="button" onClick={() => setCreateModal('flat')} disabled={!data.buildings.length}>
                  <Plus size={14} /> Add flat
                </button>
                <button className="btn btn-primary" type="button" onClick={() => setCreateModal('building')}>
                  <Plus size={14} /> Add building
                </button>
              </>
            ) : null}
            {tab === 'devices' ? (
              <>
                <button className="btn" type="button" onClick={() => setCreateModal('access-point')}>
                  <Plus size={14} /> Add access point
                </button>
                <button className="btn btn-primary" type="button" onClick={() => setCreateModal('device')}>
                  <Plus size={14} /> Provision controller
                </button>
              </>
            ) : null}
          </div>
        </div>

        {loadError ? <div className="notice danger" style={{ marginBottom: 18 }}>{loadError}</div> : null}
        {actionError ? (
          <div className="notice danger" style={{ marginBottom: 18 }}>
            {actionError}
            <button className="btn-ghost btn-small" type="button" style={{ marginLeft: 'auto' }} onClick={() => setActionError('')}>
              Dismiss
            </button>
          </div>
        ) : null}

        {loading && !data.overview ? (
          <div className="skeleton-block" aria-busy="true" />
        ) : tab === 'overview' ? (
          <OverviewTab
            data={data}
            timezone={timezone}
            onTab={setTab}
            onNewPass={() => setCreateModal('pass')}
            onPassAction={passAction}
            busyKey={busyKey}
          />
        ) : tab === 'passes' ? (
          <PassesTab
            passes={filteredPasses}
            total={data.passes.length}
            status={passStatus}
            query={passQuery}
            onStatus={setPassStatus}
            onQuery={setPassQuery}
            onAction={passAction}
            busyKey={busyKey}
            timezone={timezone}
            onNewPass={() => setCreateModal('pass')}
          />
        ) : tab === 'announcements' ? (
          <AdminAnnouncementsManager societyId={societyId} />
        ) : tab === 'helpdesk' ? (
          <AdminHelpdeskManager societyId={societyId} />
        ) : tab === 'amenities' ? (
          <AdminAmenitiesManager societyId={societyId} />
        ) : tab === 'billing' ? (
          <AdminInvoicesManager societyId={societyId} flats={flatOptions} />
        ) : tab === 'residents' ? (
          <ResidentsTab
            residents={data.residents}
            busyKey={busyKey}
            onRemove={removeMember}
            onAdd={() => setCreateModal('resident')}
          />
        ) : tab === 'staff' ? (
          <StaffTab staff={data.staff} onAdd={() => setCreateModal('guard')} />
        ) : tab === 'buildings' ? (
          <BuildingsTab
            buildings={data.buildings}
            onAddBuilding={() => setCreateModal('building')}
            onAddFlat={() => setCreateModal('flat')}
          />
        ) : tab === 'devices' ? (
          <DevicesTab
            devices={data.devices}
            accessPoints={data.accessPoints}
            commands={data.commands}
            busyKey={busyKey}
            onToggle={toggleDevice}
            onRotate={rotateDevice}
            onProvision={() => setCreateModal('device')}
            onAddAccessPoint={() => setCreateModal('access-point')}
            timezone={timezone}
          />
        ) : tab === 'logs' ? (
          <LogsTab events={data.events} audits={data.audits} timezone={timezone} />
        ) : (
          <SocietySettings
            societyId={societyId}
            initial={
              data.overview?.policy ?? {
                approvalCategories: ['DELIVERY', 'CAB'],
                maxPassDurationHours: 24,
                maxUsesPerPass: 5,
                maxPassesPerFlatPerDay: 20,
              }
            }
            onSaved={reload}
          />
        )}
      </main>

      {createModal === 'building' ? (
        <AddBuildingModal societyId={societyId} onClose={() => setCreateModal(null)} onDone={finishCreate} />
      ) : null}
      {createModal === 'flat' ? (
        <AddFlatModal buildings={data.buildings} onClose={() => setCreateModal(null)} onDone={finishCreate} />
      ) : null}
      {createModal === 'resident' ? (
        <AddResidentModal societyId={societyId} flats={flatOptions} onClose={() => setCreateModal(null)} onDone={finishCreate} />
      ) : null}
      {createModal === 'guard' ? (
        <AddGuardModal societyId={societyId} onClose={() => setCreateModal(null)} onDone={finishCreate} />
      ) : null}
      {createModal === 'access-point' ? (
        <CreateAccessPointModal societyId={societyId} onClose={() => setCreateModal(null)} onDone={finishCreate} />
      ) : null}
      {createModal === 'device' ? (
        <ProvisionDeviceModal
          societyId={societyId}
          accessPoints={data.accessPoints}
          onClose={() => setCreateModal(null)}
          onDone={finishCreate}
        />
      ) : null}
      {createModal === 'pass' ? (
        <NewPassModal
          flats={flatOptions}
          accessPoints={data.accessPoints}
          onClose={() => setCreateModal(null)}
          onCreated={(result) => {
            setCreateModal(null);
            setCredentials({
              title: 'Visitor pass issued',
              rows: [
                { label: 'PIN', value: result.credentials.pin },
                { label: 'QR token', value: result.credentials.qrToken },
              ],
              note: result.pass.requiresApproval
                ? 'This category needs approval before the pass can open a gate. Share the credential only after approval.'
                : `Valid ${formatWindow(result.pass.validFrom, result.pass.validUntil, timezone)}. Share it with ${result.pass.visitor.name}; it is shown once.`,
            });
            notify('Visitor pass issued');
            reload();
          }}
        />
      ) : null}

      {credentials ? (
        <Modal
          title={credentials.title}
          onClose={() => setCredentials(null)}
          footer={
            <button className="btn btn-primary" type="button" onClick={() => setCredentials(null)}>
              I have saved it
            </button>
          }
        >
          <CredentialReveal rows={credentials.rows} note={credentials.note} title="Shown once — copy now" />
        </Modal>
      ) : null}

      {toast ? (
        <div className={`toast ${toast.error ? 'error' : ''}`} role="status">
          <div>
            <div className="toast-title">{toast.error ? 'Something went wrong' : 'Done'}</div>
            <div className="toast-copy">{toast.message}</div>
          </div>
          <button className="icon-btn" type="button" aria-label="Dismiss" onClick={() => setToast(null)} style={{ background: 'transparent', borderColor: 'rgba(255,255,255,0.2)', color: 'inherit' }}>
            <X size={14} />
          </button>
        </div>
      ) : null}
    </AppShell>
  );
}

function OverviewTab({
  data,
  timezone,
  onTab,
  onNewPass,
  onPassAction,
  busyKey,
}: {
  data: AdminData;
  timezone: string;
  onTab: (tab: string) => void;
  onNewPass: () => void;
  onPassAction: (pass: PassView, action: 'approve' | 'revoke') => void;
  busyKey: string | null;
}) {
  const overview = data.overview;
  if (!overview) return <EmptyState title="No overview yet" copy="Refresh once the society has been set up." />;
  const counts = overview.counts;
  return (
    <>
      <section className="control-banner">
        <div className="control-main">
          <div className="control-kicker">Society command · {timezone}</div>
          <h2 className="control-title">
            {counts.openAlerts > 0 ? `${counts.openAlerts} security alert${counts.openAlerts === 1 ? '' : 's'} need attention.` : 'Every gate accounted for.'}
          </h2>
          <p className="control-copy">
            {counts.onlineDevices} of {counts.devices} controllers are reporting. {counts.allowedToday} entries were authorized and {counts.deniedToday} denied in the last 24 hours.
          </p>
          <div className="head-actions" style={{ justifyContent: 'flex-start', marginTop: 18 }}>
            <button className="btn btn-amber" type="button" onClick={onNewPass}>
              <Plus size={14} /> Issue a pass
            </button>
            <button className="btn" type="button" onClick={() => onTab('devices')} style={{ background: 'transparent', color: '#f3f7f0', borderColor: 'rgba(255,255,255,0.28)' }}>
              Inspect gates
            </button>
          </div>
        </div>
        <div className="gate-readout">
          <div className="gate-state">
            <span className="live-dot" /> {counts.onlineDevices}/{counts.devices}
          </div>
          <div className="gate-meta">controllers online</div>
          <div className="gate-meta" style={{ marginTop: 10 }}>{counts.activePasses} active passes · {counts.pendingPasses} awaiting approval</div>
        </div>
      </section>

      <div className="stat-rail">
        <Stat label="Active passes" value={counts.activePasses} note="usable right now" />
        <Stat label="Awaiting approval" value={counts.pendingPasses} note="resident or admin action" />
        <Stat label="Residents" value={counts.residents} note={`${counts.flats} flats in ${counts.buildings} buildings`} />
        <Stat label="Gates online" value={`${counts.onlineDevices}/${counts.devices}`} note="heartbeat within 2 min" />
        <Stat label="Denied · 24h" value={counts.deniedToday} note={`${counts.allowedToday} allowed`} />
      </div>

      {data.alerts.length ? (
        <section className="section-gap">
          <div className="panel">
            <div className="panel-head">
              <h2 className="panel-title">Open security alerts</h2>
              <button className="btn btn-small" type="button" onClick={() => onTab('logs')}>See audit log</button>
            </div>
            <div className="timeline">
              {data.alerts.slice(0, 5).map((alert) => (
                <div className="timeline-row" key={alert.id}>
                  <div className="timeline-time">{formatDateTime(alert.createdAt, timezone)}</div>
                  <div className="timeline-main">
                    <div className="timeline-title">{titleCase(alert.type)}</div>
                    <div className="timeline-sub">{alert.detail ? JSON.stringify(alert.detail) : 'No detail recorded'}</div>
                  </div>
                  <Badge tone={alert.severity === 'CRITICAL' || alert.severity === 'HIGH' ? 'denied' : 'warning'}>{titleCase(alert.severity)}</Badge>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      <section className="section-gap split">
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Recent gate activity</h2>
            <button className="btn btn-small" type="button" onClick={() => onTab('logs')}>Full log</button>
          </div>
          {data.events.length ? (
            <div className="timeline">
              {data.events.slice(0, 8).map((event) => (
                <div className="timeline-row" key={event.id}>
                  <div className="timeline-time">{relativeTime(event.requestedAt)}</div>
                  <div className="timeline-main">
                    <div className="timeline-title">{event.pass?.visitor.name ?? 'Unidentified credential'}</div>
                    <div className="timeline-sub">
                      {event.accessPoint?.name ?? 'Unknown gate'}
                      {event.pass ? ` · ${event.pass.flat.flatNumber}` : ''} · <ReasonText code={event.reasonCode} />
                    </div>
                  </div>
                  <DecisionBadge decision={event.decision} />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No gate activity" copy="Access attempts will appear here as soon as a controller verifies a credential." />
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Waiting on approval</h2>
            <button className="btn btn-small" type="button" onClick={() => onTab('passes')}>All passes</button>
          </div>
          {data.passes.filter((pass) => pass.effectiveStatus === 'PENDING_APPROVAL').length ? (
            <div className="timeline">
              {data.passes
                .filter((pass) => pass.effectiveStatus === 'PENDING_APPROVAL')
                .slice(0, 6)
                .map((pass) => (
                  <div className="timeline-row" key={pass.id}>
                    <div className="timeline-time">{formatDateTime(pass.validFrom, timezone)}</div>
                    <div className="timeline-main">
                      <div className="timeline-title">{pass.visitor.name}</div>
                      <div className="timeline-sub">{categoryLabel(pass.category)} · {pass.flat.building} {pass.flat.flatNumber}</div>
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
            <EmptyState title="Inbox clear" copy="No visitor pass is waiting for approval." />
          )}
        </div>
      </section>
    </>
  );
}

function PassesTab({
  passes,
  total,
  status,
  query,
  onStatus,
  onQuery,
  onAction,
  busyKey,
  timezone,
  onNewPass,
}: {
  passes: PassView[];
  total: number;
  status: string;
  query: string;
  onStatus: (value: string) => void;
  onQuery: (value: string) => void;
  onAction: (pass: PassView, action: 'approve' | 'revoke') => void;
  busyKey: string | null;
  timezone: string;
  onNewPass: () => void;
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Visitor passes <span className="small muted">({total})</span></h2>
        <div className="filter-row">
          <input
            className="input"
            style={{ width: 220 }}
            placeholder="Visitor, flat or host"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            aria-label="Search passes"
          />
          <select className="select" style={{ width: 170 }} value={status} onChange={(event) => onStatus(event.target.value)} aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="PENDING_APPROVAL">Awaiting approval</option>
            <option value="SCHEDULED">Scheduled</option>
            <option value="EXPIRED">Expired</option>
            <option value="EXHAUSTED">Exhausted</option>
            <option value="REVOKED">Revoked</option>
          </select>
        </div>
      </div>
      {passes.length ? (
        <div>
          {passes.map((pass) => (
            <div className="pass-row" key={pass.id}>
              <div>
                <div className="pass-name">{pass.visitor.name}</div>
                <div className="pass-meta">
                  {categoryLabel(pass.category)} · {pass.flat.building} {pass.flat.flatNumber} · host {pass.host.name}
                </div>
              </div>
              <div className="pass-window">
                {formatWindow(pass.validFrom, pass.validUntil, timezone)}
                <div className="pass-meta">{pass.usedCount} of {pass.maxUses} entries used</div>
              </div>
              <PassBadge status={pass.effectiveStatus} />
              <div className="pass-actions">
                {pass.effectiveStatus === 'PENDING_APPROVAL' ? (
                  <button className="btn btn-small btn-primary" type="button" disabled={busyKey === `pass:${pass.id}`} onClick={() => onAction(pass, 'approve')}>
                    <Check size={13} /> Approve
                  </button>
                ) : null}
                {['ACTIVE', 'PENDING_APPROVAL', 'SCHEDULED'].includes(pass.effectiveStatus) ? (
                  <button className="btn btn-small btn-danger" type="button" disabled={busyKey === `pass:${pass.id}`} onClick={() => onAction(pass, 'revoke')}>
                    <Ban size={13} /> Revoke
                  </button>
                ) : null}
                {!['ACTIVE', 'PENDING_APPROVAL', 'SCHEDULED'].includes(pass.effectiveStatus) ? (
                  <span className="tiny muted">{formatDateTime(pass.validUntil, timezone)}</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          title={total ? 'No passes match this filter' : 'No visitor passes yet'}
          copy={total ? 'Clear the search or switch the status filter.' : 'Issue the first pass for a resident, with a one-time PIN and QR token.'}
          action={<button className="btn btn-primary" type="button" onClick={onNewPass}><Plus size={14} /> Issue a pass</button>}
        />
      )}
    </div>
  );
}

function ResidentsTab({
  residents,
  busyKey,
  onRemove,
  onAdd,
}: {
  residents: Resident[];
  busyKey: string | null;
  onRemove: (userId: string, flatId: string, name: string, label: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Residents <span className="small muted">({residents.length})</span></h2>
        <button className="btn btn-small" type="button" onClick={onAdd}><Plus size={13} /> Add resident</button>
      </div>
      {residents.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Resident</th>
                <th>Contact</th>
                <th>Flats</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {residents.map((resident) => (
                <tr key={resident.userId}>
                  <td>
                    <div style={{ fontWeight: 650 }}>{resident.name}</div>
                    <div className="tiny muted">Account {resident.userId.slice(0, 8)}</div>
                  </td>
                  <td>
                    <div className="small">{resident.email ?? '—'}</div>
                    <div className="tiny muted">{resident.phone ?? 'No phone'}</div>
                  </td>
                  <td>
                    {resident.flats.length ? (
                      <div className="stack" style={{ gap: 6 }}>
                        {resident.flats.map((flat) => (
                          <div key={flat.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span className="small">{flat.building} · {flat.flatNumber}</span>
                            <Badge tone="neutral">{titleCase(flat.relationship)}</Badge>
                            <button
                              className="btn btn-ghost btn-small"
                              type="button"
                              disabled={busyKey === `member:${resident.userId}:${flat.id}`}
                              onClick={() => onRemove(resident.userId, flat.id, resident.name, `${flat.building} ${flat.flatNumber}`)}
                            >
                              End
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="small muted">No active flat</span>
                    )}
                  </td>
                  <td><Badge tone={resident.status === 'ACTIVE' ? 'active' : resident.status === 'INVITED' ? 'pending' : 'disabled'}>{titleCase(resident.status)}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No residents yet" copy="Add a resident to a flat. They receive a temporary password and must replace it at first sign-in." action={<button className="btn btn-primary" type="button" onClick={onAdd}><Plus size={14} /> Add resident</button>} />
      )}
    </div>
  );
}

function StaffTab({ staff, onAdd }: { staff: StaffMember[]; onAdd: () => void }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Security team <span className="small muted">({staff.length})</span></h2>
        <button className="btn btn-small" type="button" onClick={onAdd}><Plus size={13} /> Add guard</button>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Contact</th>
              <th>Role</th>
              <th>Status</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((member) => (
              <tr key={`${member.userId}:${member.role}`}>
                <td style={{ fontWeight: 650 }}>{member.name}</td>
                <td>
                  <div className="small">{member.email ?? '—'}</div>
                  <div className="tiny muted">{member.phone ?? 'No phone'}</div>
                </td>
                <td><Badge tone={member.role === 'SOCIETY_ADMIN' ? 'info' : 'neutral'}>{roleLabel(member.role)}</Badge></td>
                <td><Badge tone={member.status === 'ACTIVE' ? 'active' : member.status === 'INVITED' ? 'pending' : 'disabled'}>{titleCase(member.status)}</Badge></td>
                <td className="small muted">{formatDateTime(member.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BuildingsTab({
  buildings,
  onAddBuilding,
  onAddFlat,
}: {
  buildings: Building[];
  onAddBuilding: () => void;
  onAddFlat: () => void;
}) {
  const flatCount = buildings.reduce((sum, building) => sum + building.flats.length, 0);
  return (
    <>
      <div className="head-actions" style={{ justifyContent: 'flex-start', marginBottom: 16 }}>
        <button className="btn" type="button" onClick={onAddFlat} disabled={!buildings.length}><Plus size={14} /> Add flat</button>
        <button className="btn btn-primary" type="button" onClick={onAddBuilding}><Plus size={14} /> Add building</button>
      </div>
      {buildings.length ? (
        <div className="grid-2">
          {buildings.map((building) => (
            <div className="panel" key={building.id}>
              <div className="panel-head">
                <h2 className="panel-title">{building.name}</h2>
                <span className="badge neutral">{building.flats.length} flats</span>
              </div>
              <div className="panel-body" style={{ padding: 14 }}>
                {building.flats.length ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
                    {building.flats.map((flat) => (
                      <div key={flat.id} style={{ border: '1px solid var(--line)', padding: '9px 10px', background: '#fff' }}>
                        <div style={{ fontWeight: 650, fontSize: 13 }}>{flat.flatNumber}</div>
                        <div className="tiny muted">{flat.residentCount} resident{flat.residentCount === 1 ? '' : 's'}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="small muted">No flats yet. Add the first flat to this building.</p>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="No buildings yet" copy="Create a building, then add flats and residents to it." action={<button className="btn btn-primary" type="button" onClick={onAddBuilding}><Plus size={14} /> Add building</button>} />
      )}
      {buildings.length ? <p className="hint" style={{ marginTop: 14 }}>{buildings.length} buildings · {flatCount} flats. A flat can host multiple residents; passes are always issued against a flat.</p> : null}
    </>
  );
}

function DevicesTab({
  devices,
  accessPoints,
  commands,
  busyKey,
  onToggle,
  onRotate,
  onProvision,
  onAddAccessPoint,
  timezone,
}: {
  devices: Device[];
  accessPoints: AccessPoint[];
  commands: GateCommand[];
  busyKey: string | null;
  onToggle: (device: Device) => void;
  onRotate: (device: Device) => void;
  onProvision: () => void;
  onAddAccessPoint: () => void;
  timezone: string;
}) {
  return (
    <>
      <div className="head-actions" style={{ justifyContent: 'flex-start', marginBottom: 16 }}>
        <button className="btn" type="button" onClick={onAddAccessPoint}><Plus size={14} /> Add access point</button>
        <button className="btn btn-primary" type="button" onClick={onProvision} disabled={!accessPoints.length}><Plus size={14} /> Provision controller</button>
      </div>

      <div className="grid-2">
        {accessPoints.map((accessPoint) => (
          <div className="panel" key={accessPoint.id}>
            <div className="panel-head">
              <h2 className="panel-title">{accessPoint.name}</h2>
              <Badge tone="neutral">{titleCase(accessPoint.type)}</Badge>
            </div>
            <div className="panel-body">
              <p className="small muted">{accessPoint.location || 'No location note'}</p>
              <div className="small" style={{ marginTop: 10 }}>
                {accessPoint.devices?.length
                  ? `Assigned to ${accessPoint.devices.map((device) => device.name).join(', ')}`
                  : 'No controller assigned. Provision a controller to operate this gate.'}
              </div>
            </div>
          </div>
        ))}
      </div>
      {!accessPoints.length ? (
        <EmptyState title="No access points" copy="Add a gate or door, then provision a controller against it." action={<button className="btn btn-primary" type="button" onClick={onAddAccessPoint}><Plus size={14} /> Add access point</button>} />
      ) : null}

      <div className="panel section-gap">
        <div className="panel-head">
          <h2 className="panel-title">Controllers <span className="small muted">({devices.length})</span></h2>
          <span className="small muted">{devices.filter((device) => device.lastSeenAt && Date.now() - new Date(device.lastSeenAt).getTime() < 120_000).length} online</span>
        </div>
        {devices.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Controller</th>
                  <th>Gates</th>
                  <th>Last seen</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {devices.map((device) => (
                  <tr key={device.id}>
                    <td>
                      <div style={{ fontWeight: 650 }}>{device.name}</div>
                      <div className="tiny muted">{device.deviceUid} · {device.firmware || 'unknown firmware'}</div>
                    </td>
                    <td className="small">{device.accessPoints.map((accessPoint) => accessPoint.name).join(', ') || '—'}</td>
                    <td className="small muted">{relativeTime(device.lastSeenAt)}</td>
                    <td><Badge tone={device.status === 'ACTIVE' && device.lastSeenAt && Date.now() - new Date(device.lastSeenAt).getTime() < 120_000 ? 'active' : device.status === 'ACTIVE' ? 'pending' : 'disabled'}>{device.status === 'ACTIVE' ? (device.lastSeenAt && Date.now() - new Date(device.lastSeenAt).getTime() < 120_000 ? 'Online' : 'Stale') : titleCase(device.status)}</Badge></td>
                    <td>
                      <div className="row-actions">
                        <button className="btn btn-small" type="button" disabled={busyKey === `rotate:${device.id}`} onClick={() => onRotate(device)}>
                          <RotateCw size={13} /> Rotate
                        </button>
                        <button className={`btn btn-small ${device.status === 'ACTIVE' ? 'btn-danger' : ''}`} type="button" disabled={busyKey === `device:${device.id}`} onClick={() => onToggle(device)}>
                          {device.status === 'ACTIVE' ? <><Ban size={13} /> Disable</> : <><Check size={13} /> Enable</>}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No controllers provisioned" copy="Provision a controller to obtain its device token and command secret. Secrets are shown once." action={<button className="btn btn-primary" type="button" onClick={onProvision} disabled={!accessPoints.length}><Plus size={14} /> Provision controller</button>} />
        )}
      </div>

      <div className="panel section-gap">
        <div className="panel-head">
          <h2 className="panel-title">Recent gate commands</h2>
          <span className="small muted">Signed · expiring</span>
        </div>
        {commands.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Issued</th>
                  <th>Gate</th>
                  <th>Command</th>
                  <th>Status</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody>
                {commands.slice(0, 12).map((command) => (
                  <tr key={command.id}>
                    <td className="small muted">{formatDateTime(command.issuedAt, timezone)}</td>
                    <td className="small">{command.accessPoint.name}<div className="tiny muted">{command.device.name}</div></td>
                    <td><Badge tone={command.type === 'OPEN' ? 'active' : 'neutral'}>{command.type}</Badge></td>
                    <td><Badge tone={command.status === 'EXECUTED' ? 'active' : command.status === 'FAILED' || command.status === 'EXPIRED' ? 'expired' : 'pending'}>{titleCase(command.status)}</Badge></td>
                    <td className="small muted">{formatDateTime(command.expiresAt, timezone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No gate commands" copy="Commands appear when a guard uses the console or a controller verifies a credential." />
        )}
      </div>
    </>
  );
}

function LogsTab({ events, audits, timezone }: { events: AccessEvent[]; audits: AuditLog[]; timezone: string }) {
  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Access decisions</h2>
          <span className="small muted">Latest {events.length}</span>
        </div>
        {events.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Gate</th>
                  <th>Visitor</th>
                  <th>Credential</th>
                  <th>Decision</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="small muted">{formatDateTime(event.requestedAt, timezone)}</td>
                    <td className="small">{event.accessPoint?.name ?? 'Unknown'}</td>
                    <td className="small">
                      {event.pass?.visitor.name ?? '—'}
                      {event.pass ? <div className="tiny muted">Flat {event.pass.flat.flatNumber}</div> : null}
                    </td>
                    <td className="small">{event.credentialType ?? '—'}<div className="tiny muted">{titleCase(event.source)}</div></td>
                    <td><DecisionBadge decision={event.decision} /></td>
                    <td><ReasonText code={event.reasonCode} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No access decisions yet" copy="Every successful and denied verification is written here." />
        )}
      </div>

      <div className="panel section-gap">
        <div className="panel-head">
          <h2 className="panel-title">Administrative audit trail</h2>
          <span className="small muted">Append-only · latest {audits.length}</span>
        </div>
        {audits.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {audits.map((entry) => (
                  <tr key={entry.id}>
                    <td className="small muted">{formatDateTime(entry.createdAt, timezone)}</td>
                    <td className="small">{entry.actorRole ? roleLabel(entry.actorRole) : 'System'}<div className="tiny muted">{entry.actorUserId ? entry.actorUserId.slice(0, 8) : '—'}</div></td>
                    <td className="small">{titleCase(entry.action)}</td>
                    <td className="small">{entry.entityType}<div className="tiny muted">{entry.entityId ? entry.entityId.slice(0, 8) : '—'}</div></td>
                    <td className="tiny muted" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.meta ? JSON.stringify(entry.meta) : ''}>
                      {entry.meta ? JSON.stringify(entry.meta) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No admin actions recorded" copy="Society changes, credential rotations and pass decisions are appended here." />
        )}
      </div>
    </>
  );
}
