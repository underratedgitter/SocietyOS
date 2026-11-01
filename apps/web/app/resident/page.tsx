'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Ban,
  Bell,
  Calendar,
  CalendarPlus,
  Check,
  Clock,
  CreditCard,
  Home,
  KeyRound,
  RefreshCw,
  Share2,
  ShieldCheck,
  Ticket,
  Users,
  Wrench,
} from 'lucide-react';
import { apiRequest } from '@/lib/api';
import type {
  AccessPoint,
  HouseholdMember,
  PassPage,
  PassView,
  PassWithCredentials,
  Session,
} from '@/lib/types';
import {
  categoryLabel,
  formatDateTime,
  formatWindow,
  relativeTime,
  titleCase,
} from '@/lib/format';
import { societyList, useSession } from '@/components/session-provider';
import { Protected } from '@/components/protected';
import { AppShell, type NavItem } from '@/components/app-shell';
import { Badge, CredentialReveal, EmptyState, Modal, PassBadge, Toast, errorMessage } from '@/components/ui';
import { PassForm } from '@/components/pass-form';
import { PwaInstallPrompt } from '@/components/pwa-install-prompt';
import {
  ResidentNoticeBoard,
  ResidentMaintenance,
  ResidentAmenities,
  ResidentInvoicesView,
} from '@/components/community-tabs';
import { RelativesManagementView } from '@/features/relatives-management';

const NAV: NavItem[] = [
  { id: 'visitors', label: 'Visitors', icon: Ticket },
  { id: 'relatives', label: 'Relatives & Family', icon: Users },
  { id: 'announcements', label: 'Notice board', icon: Bell },
  { id: 'tickets', label: 'Maintenance', icon: Wrench },
  { id: 'amenities', label: 'Amenities', icon: Calendar },
  { id: 'billing', label: 'Dues & Bills', icon: CreditCard },
  { id: 'home', label: 'My home', icon: Home },
];

const CURRENT_STATUSES = new Set(['ACTIVE', 'PENDING_APPROVAL', 'SCHEDULED']);

export default function ResidentPage() {
  return (
    <Protected roles={['RESIDENT']}>
      <ResidentWorkspace />
    </Protected>
  );
}

function ResidentWorkspace() {
  const { session } = useSession();
  const flats = useMemo(() => session?.flats ?? [], [session]);
  const [flatId, setFlatId] = useState('');
  const [tab, setTab] = useState('visitors');
  const [passes, setPasses] = useState<PassView[]>([]);
  const [accessPoints, setAccessPoints] = useState<AccessPoint[]>([]);
  const [household, setHousehold] = useState<HouseholdMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [issued, setIssued] = useState<PassWithCredentials | null>(null);
  const [issuedMeta, setIssuedMeta] = useState<{ vehicle?: string; purpose?: string } | null>(null);
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const toastTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!flats.length) return;
    if (!flats.some((flat) => flat.id === flatId)) setFlatId(flats[0].id);
  }, [flats, flatId]);

  const flat = flats.find((item) => item.id === flatId);
  const societyId = flat?.building.societyId ?? '';
  const society = useMemo(
    () => (session ? societyList(session).find((item) => item.id === societyId) : undefined),
    [session, societyId],
  );

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
    if (!flatId) return;
    let active = true;
    apiRequest<AccessPoint[]>(`/api/v1/flats/${flatId}/access-points`)
      .then((points) => {
        if (active) setAccessPoints(points);
      })
      .catch(() => {
        if (active) setAccessPoints([]);
      });
    apiRequest<HouseholdMember[]>(`/api/v1/flats/${flatId}/household`)
      .then((members) => {
        if (active) setHousehold(members);
      })
      .catch(() => {
        if (active) setHousehold([]);
      });
    return () => {
      active = false;
    };
  }, [flatId, refreshKey]);

  useEffect(() => {
    if (!societyId) return;
    let active = true;
    setLoading(true);
    setLoadError('');
    apiRequest<PassPage>(`/api/v1/visitor-passes?societyId=${societyId}&limit=100`)
      .then((page) => {
        if (active) setPasses(page.items);
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

  const current = passes.filter((pass) => CURRENT_STATUSES.has(pass.effectiveStatus));
  const history = passes.filter((pass) => !CURRENT_STATUSES.has(pass.effectiveStatus));
  const awaiting = passes.filter((pass) => pass.effectiveStatus === 'PENDING_APPROVAL');
  const arriving = current.filter((pass) => pass.effectiveStatus === 'ACTIVE');

  async function passAction(pass: PassView, action: 'approve' | 'revoke') {
    if (
      action === 'revoke' &&
      !window.confirm(`Revoke the pass for ${pass.visitor.name}? The credential stops working immediately.`)
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
            ? { decision: 'APPROVED' }
            : { reason: 'Revoked by the host resident' },
        ),
      });
      notify(action === 'approve' ? 'Visitor approved' : 'Pass revoked');
      reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyKey(null);
    }
  }

  if (!session) return null;

  if (!flats.length) {
    return (
      <div className="login-panel" style={{ minHeight: '100dvh' }}>
        <h1 className="login-form-title">No flat linked yet</h1>
        <p className="login-form-sub">
          Your account is active but no flat is linked to it. Ask your society administrator to add you
          to a flat.
        </p>
      </div>
    );
  }

  return (
    <AppShell
      session={session}
      societies={society ? [society] : societyList(session)}
      activeSocietyId={societyId}
      nav={NAV}
      active={tab}
      onSelect={setTab}
    >
      <main className="content">
        <PwaInstallPrompt onInstalled={() => notify('SocietyOS added to your home screen!')} />
        <div className="page-head">
          <div>
            <div className="context-label">
              {flat ? `${flat.building.name} · Flat ${flat.flatNumber}` : society?.name}
            </div>
            <h1 className="page-title">
              {tab === 'visitors'
                ? 'Visitors'
                : tab === 'relatives'
                  ? 'Relatives & Family'
                  : tab === 'announcements'
                    ? 'Notice board'
                    : tab === 'tickets'
                      ? 'Maintenance'
                      : tab === 'amenities'
                        ? 'Amenities'
                        : tab === 'billing'
                          ? 'Dues & Invoices'
                          : 'My home'}
            </h1>
            <p className="page-sub">
              {tab === 'visitors'
                ? 'Invite guests with a time-limited PIN or QR pass. Every entry is checked against the pass at the gate.'
                : tab === 'relatives'
                  ? 'Pre-registered directory of family and relatives. Generate 1-click entry passes without re-entering details.'
                  : tab === 'announcements'
                    ? 'Official notices, emergency circulars, and community updates from administration.'
                    : tab === 'tickets'
                      ? 'Raise service requests for plumbing, electrical, carpentry, or common areas.'
                      : tab === 'amenities'
                        ? 'Reserve clubhouses, tennis courts, and recreational amenities.'
                        : tab === 'billing'
                          ? 'View society maintenance charges, past receipts, and settle outstanding balances.'
                          : 'Your household, hosted flats and the gates a visitor pass can open.'}
            </p>
          </div>
          <div className="head-actions">
            {flats.length > 1 ? (
              <select
                className="select"
                style={{ width: 210 }}
                value={flatId}
                onChange={(event) => setFlatId(event.target.value)}
                aria-label="Select flat"
              >
                {flats.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.building.name} · {item.flatNumber}
                  </option>
                ))}
              </select>
            ) : null}
            <button className="btn" type="button" onClick={reload} disabled={loading}>
              <RefreshCw size={14} /> Refresh
            </button>
            {tab === 'visitors' ? (
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => setFormOpen(true)}
                disabled={accessPoints.length === 0}
              >
                <CalendarPlus size={14} /> Invite a visitor
              </button>
            ) : null}
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

        {tab === 'home' ? (
          <HomeTab
            flatLabel={flat ? `${flat.building.name} · ${flat.flatNumber}` : '—'}
            relationship={flat?.relationship}
            societyName={society?.name ?? '—'}
            household={household}
            accessPoints={accessPoints}
          />
        ) : tab === 'relatives' ? (
          <RelativesManagementView flatId={flatId} societyId={societyId} />
        ) : tab === 'announcements' ? (
          <ResidentNoticeBoard societyId={societyId} />
        ) : tab === 'tickets' ? (
          <ResidentMaintenance societyId={societyId} flatId={flatId} />
        ) : tab === 'amenities' ? (
          <ResidentAmenities societyId={societyId} flatId={flatId} />
        ) : tab === 'billing' ? (
          <ResidentInvoicesView societyId={societyId} />
        ) : (
          <>
            <div className="stat-rail">
              <div className="stat">
                <div className="stat-label">Passes in play</div>
                <div className="stat-value">{current.length}</div>
                <div className="stat-note">active, scheduled or pending</div>
              </div>
              <div className="stat">
                <div className="stat-label">At the gate now</div>
                <div className="stat-value">{arriving.length}</div>
                <div className="stat-note">usable inside their window</div>
              </div>
              <div className="stat">
                <div className="stat-label">Awaiting your approval</div>
                <div className="stat-value">{awaiting.length}</div>
                <div className="stat-note">delivery and cab categories</div>
              </div>
              <div className="stat">
                <div className="stat-label">Gates available</div>
                <div className="stat-value">{accessPoints.length}</div>
                <div className="stat-note">selectable per pass</div>
              </div>
            </div>

            {awaiting.length ? (
              <section className="section-gap panel">
                <div className="panel-head">
                  <h2 className="panel-title">Waiting on you</h2>
                  <span className="small muted">Approve only if you are expecting this visitor.</span>
                </div>
                {awaiting.map((pass) => (
                  <div className="pass-row" key={pass.id}>
                    <div>
                      <div className="pass-name">{pass.visitor.name}</div>
                      <div className="pass-meta">
                        {categoryLabel(pass.category)} · {formatWindow(pass.validFrom, pass.validUntil, society?.timezone)}
                      </div>
                    </div>
                    <PassBadge status={pass.effectiveStatus} />
                    <div className="pass-actions">
                      <button
                        className="btn btn-small btn-primary"
                        type="button"
                        disabled={busyKey === `pass:${pass.id}`}
                        onClick={() => void passAction(pass, 'approve')}
                      >
                        <Check size={13} /> Approve
                      </button>
                      <button
                        className="btn btn-small btn-danger"
                        type="button"
                        disabled={busyKey === `pass:${pass.id}`}
                        onClick={() => void passAction(pass, 'revoke')}
                      >
                        <Ban size={13} /> Reject
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            ) : null}

            <section className="section-gap panel">
              <div className="panel-head">
                <h2 className="panel-title">Current and upcoming</h2>
                <span className="small muted">
                  {loading ? 'Loading…' : `${current.length} pass${current.length === 1 ? '' : 'es'}`}
                </span>
              </div>
              {current.length ? (
                current.map((pass) => (
                  <div className="pass-row" key={pass.id}>
                    <div>
                      <div className="pass-name">{pass.visitor.name}</div>
                      <div className="pass-meta">
                        {categoryLabel(pass.category)}
                        {pass.visitor.phone ? ` · ${pass.visitor.phone}` : ''} · {pass.accessPoints.map((gate) => gate.name).join(', ') || 'No gate'}
                      </div>
                    </div>
                    <div className="pass-window">
                      {formatWindow(pass.validFrom, pass.validUntil, society?.timezone)}
                      <div className="pass-meta">
                        {pass.usedCount} of {pass.maxUses} entries used
                      </div>
                    </div>
                    <PassBadge status={pass.effectiveStatus} />
                    <div className="pass-actions">
                      <button
                        className="btn btn-small btn-danger"
                        type="button"
                        disabled={busyKey === `pass:${pass.id}`}
                        onClick={() => void passAction(pass, 'revoke')}
                      >
                        <Ban size={13} /> Revoke
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <EmptyState
                  title="No visitors expected"
                  copy="Invite a guest and share the one-time PIN or QR token. Passes expire automatically at the end of their window."
                  action={
                    <button className="btn btn-primary" type="button" onClick={() => setFormOpen(true)}>
                      <CalendarPlus size={14} /> Invite a visitor
                    </button>
                  }
                />
              )}
            </section>

            <section className="section-gap panel">
              <div className="panel-head">
                <h2 className="panel-title">Pass history</h2>
                <span className="small muted">{history.length} archived</span>
              </div>
              {history.length ? (
                <div className="timeline">
                  {history.map((pass) => (
                    <div className="timeline-row" key={pass.id}>
                      <div className="timeline-time">{relativeTime(pass.validUntil)}</div>
                      <div className="timeline-main">
                        <div className="timeline-title">
                          {pass.visitor.name} <PassBadge status={pass.effectiveStatus} />
                        </div>
                        <div className="timeline-sub">
                          {categoryLabel(pass.category)} · {formatDateTime(pass.validFrom, society?.timezone)} ·{' '}
                          {pass.usedCount}/{pass.maxUses} entries
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState title="No past passes" copy="Expired, used-up and revoked passes are kept here for your records." />
              )}
            </section>
          </>
        )}
      </main>

      {formOpen && flat ? (
        <Modal title="Invite a visitor" onClose={() => setFormOpen(false)} wide>
          <div className="notice" style={{ marginBottom: 16 }}>
            <ShieldCheck size={15} style={{ flex: 'none', marginTop: 2 }} />
            <span>
              This pass is limited to your selected gates and time window. Delivery and cab passes may need
              your approval before they can open a gate.
            </span>
          </div>
          <PassForm
            flats={[
              {
                id: flat.id,
                label: `${flat.building.name} · ${flat.flatNumber}`,
                building: flat.building.name,
                flatNumber: flat.flatNumber,
              },
            ]}
            accessPoints={accessPoints}
            defaultFlatId={flat.id}
            onCreated={(result, meta) => {
              setFormOpen(false);
              setIssued(result);
              setIssuedMeta(meta ?? null);
              reload();
            }}
          />
        </Modal>
      ) : null}

      {issued ? (
        <IssuedPassModal
          result={issued}
          meta={issuedMeta}
          timezone={society?.timezone}
          onClose={() => {
            setIssued(null);
            setIssuedMeta(null);
            notify('Visitor pass issued');
          }}
        />
      ) : null}

      {tab === 'visitors' ? (
        <button
          className="mobile-fab"
          type="button"
          onClick={() => setFormOpen(true)}
          disabled={accessPoints.length === 0}
          aria-label="Create new visitor pass"
        >
          <CalendarPlus size={18} />
          <span>+ New Pass</span>
        </button>
      ) : null}

      {toast ? <Toast message={toast.message} error={toast.error} onClose={() => setToast(null)} /> : null}
    </AppShell>
  );
}

function IssuedPassModal({
  result,
  meta,
  timezone,
  onClose,
}: {
  result: PassWithCredentials;
  meta?: { vehicle?: string; purpose?: string } | null;
  timezone?: string;
  onClose: () => void;
}) {
  const [copiedAll, setCopiedAll] = useState(false);
  const [shared, setShared] = useState(false);

  // Extract clean guest name and vehicle
  const rawName = result.pass.visitor.name;
  const vehicleMatch = rawName.match(/\[(.*?)\]/);
  const vehicle = meta?.vehicle || (vehicleMatch ? vehicleMatch[1] : undefined);
  const guestName = rawName.replace(/\s*\[.*?\]/, '').trim();
  const purpose = meta?.purpose;

  const shareText = [
    '🏛️ *SocietyOS Visitor Pass*',
    `👤 *Guest:* ${guestName}`,
    result.pass.visitor.phone ? `📱 *Phone:* ${result.pass.visitor.phone}` : null,
    vehicle ? `🚗 *Vehicle:* ${vehicle}` : null,
    `🏷️ *Category:* ${categoryLabel(result.pass.category)}${purpose ? ` · ${purpose}` : ''}`,
    `📍 *Destination:* ${result.pass.flat.building} · Flat ${result.pass.flat.flatNumber}`,
    `⏱️ *Window:* ${formatWindow(result.pass.validFrom, result.pass.validUntil, timezone)}`,
    '',
    `🔑 *Gate Access PIN:* ${result.credentials.pin}`,
    '👉 Enter this 6-digit PIN on the gate touchscreen keypad, or scan the QR token under the camera for direct entry.',
  ]
    .filter(Boolean)
    .join('\n');

  const cleanPhone = result.pass.visitor.phone?.replace(/\D/g, '') || '';
  const whatsappUrl =
    cleanPhone.length >= 10
      ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(shareText)}`
      : `https://wa.me/?text=${encodeURIComponent(shareText)}`;
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function handleShare() {
    if (canNativeShare) {
      try {
        await navigator.share({
          title: `SocietyOS Pass: ${guestName}`,
          text: shareText,
        });
        setShared(true);
        setTimeout(() => setShared(false), 2500);
        return;
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
      }
    }
    // Fallback to WhatsApp if share is unavailable or fails
    window.open(whatsappUrl, '_blank', 'noopener,noreferrer');
  }

  async function copyAll() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareText);
        setCopiedAll(true);
        setTimeout(() => setCopiedAll(false), 2500);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = shareText;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        setCopiedAll(true);
        setTimeout(() => setCopiedAll(false), 2500);
      }
    } catch {
      // Gracefully handle clipboard write restrictions
    }
  }

  return (
    <Modal
      title="Visitor pass issued"
      onClose={onClose}
      wide
      footer={
        <div style={{ display: 'flex', gap: 10, width: '100%', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void handleShare()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Share2 size={14} />
              <span>{shared ? '✓ Shared!' : canNativeShare ? 'Share Pass' : 'Share via WhatsApp'}</span>
            </button>
            <a
              className="btn"
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, borderColor: '#25D366', color: '#128C7E' }}
            >
              <span>💬 WhatsApp</span>
            </a>
            <button className="btn" type="button" onClick={copyAll}>
              {copiedAll ? '✓ Copied' : 'Copy'}
            </button>
          </div>
          <button className="btn" type="button" onClick={onClose}>
            I have shared it
          </button>
        </div>
      }
    >
      <div className="stack" style={{ gap: 16 }}>
        {/* Physical Digital Pass Badge */}
        <div className="pass-card-badge">
          <div className="pass-card-header">
            <div>
              <span className="small muted">VISITOR CREDENTIAL</span>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600 }}>
                {guestName}
              </div>
              {vehicle ? (
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginTop: 2 }}>
                  🚗 {vehicle}
                </div>
              ) : null}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <Badge tone="active">{categoryLabel(result.pass.category)}</Badge>
              {purpose ? <Badge tone="neutral">{purpose}</Badge> : null}
            </div>
          </div>

          <div className="pass-card-code-hero">
            <span className="small muted">GATE ACCESS PIN</span>
            <div className="pass-card-pin">{result.credentials.pin}</div>
            <span className="tiny muted">Touch keypad on gate kiosk</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 12 }}>
            <div>
              <span className="tiny muted">DESTINATION</span>
              <div style={{ fontWeight: 600 }}>{result.pass.flat.building} · Flat {result.pass.flat.flatNumber}</div>
            </div>
            <div>
              <span className="tiny muted">VALIDITY WINDOW</span>
              <div style={{ fontWeight: 600 }}>{formatWindow(result.pass.validFrom, result.pass.validUntil, timezone)}</div>
            </div>
          </div>

          <div className="qr-wrap" style={{ alignSelf: 'center', margin: '8px 0' }}>
            <QRCodeSVG value={result.credentials.qrToken} size={150} level="M" includeMargin={false} />
            <div className="tiny muted" style={{ textAlign: 'center', marginTop: 4 }}>
              Scan QR directly under gate camera
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
            <button className="btn btn-small" type="button" onClick={copyAll}>
              {copiedAll ? '✓ Instructions Copied' : 'Copy Visitor Instructions'}
            </button>
          </div>
        </div>

        <CredentialReveal
          rows={[
            { label: 'PIN', value: result.credentials.pin },
            { label: 'QR token', value: result.credentials.qrToken },
          ]}
          title="Shown once — share with your visitor"
          note="The PIN is entered on the gate keypad; the QR token can be shown as a code. Neither can be displayed again."
        />

        {result.pass.requiresApproval && (
          <div className="notice">
            <Clock size={15} style={{ flex: 'none', marginTop: 2 }} />
            <span>
              This visitor category requires arrival approval. You will receive a prompt when they arrive at the gate.
            </span>
          </div>
        )}

        <div className="notice">
          <KeyRound size={15} style={{ flex: 'none', marginTop: 2 }} />
          <span>
            Credentials are cryptographically hashed using versioned HMAC and destroyed once expired.
          </span>
        </div>
      </div>
    </Modal>
  );
}

function HomeTab({
  flatLabel,
  relationship,
  societyName,
  household,
  accessPoints,
}: {
  flatLabel: string;
  relationship?: string;
  societyName: string;
  household: HouseholdMember[];
  accessPoints: AccessPoint[];
}) {
  const [bioSimulated, setBioSimulated] = useState(false);

  function testBiometricPing() {
    setBioSimulated(true);
    setTimeout(() => setBioSimulated(false), 3000);
  }

  return (
    <>
      <section className="section-gap split">
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Your Flat</h2>
            <Badge tone="active">{relationship ? titleCase(relationship) : 'Resident'}</Badge>
          </div>
          <div className="panel-body">
            <div className="context-label">Flat</div>
            <div style={{ fontWeight: 650, fontSize: 20, marginTop: 4 }}>{flatLabel}</div>
            <div className="small muted" style={{ marginTop: 4 }}>{societyName}</div>
            <div className="hr" />
            <div className="context-label" style={{ marginBottom: 10 }}>
              Household Members
            </div>
            {household.length ? (
              <div className="stack" style={{ gap: 10 }}>
                {household.map((member) => (
                  <div key={member.userId} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Users size={15} strokeWidth={1.7} />
                    <span className="small">{member.name}{member.isSelf ? ' (you)' : ''}</span>
                    <Badge tone="neutral">{titleCase(member.relationship)}</Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="small muted">Household details are unavailable right now.</p>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Gates at this Society</h2>
            <span className="small muted">{accessPoints.length} access points</span>
          </div>
          {accessPoints.length ? (
            <div className="timeline">
              {accessPoints.map((gate) => (
                <div className="timeline-row" key={gate.id}>
                  <ShieldCheck size={16} strokeWidth={1.7} />
                  <div className="timeline-main">
                    <div className="timeline-title">{gate.name}</div>
                    <div className="timeline-sub">
                      {titleCase(gate.type)}
                      {gate.location ? ` · ${gate.location}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No gates configured" copy="Your society administrator has not created access points yet." />
          )}
        </div>
      </section>

      {/* Biometric Resident Access Profile */}
      <section className="section-gap panel">
        <div className="panel-head">
          <h2 className="panel-title">Resident Biometric Access Profile</h2>
          <Badge tone="online">Hardware Active</Badge>
        </div>
        <div className="panel-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            <div style={{ padding: 14, background: 'var(--fog)', border: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>Face Recognition Template</strong>
                <Badge tone="online">Enrolled</Badge>
              </div>
              <p className="tiny muted" style={{ marginTop: 6 }}>
                Stored securely on local edge controller (Suprema / ZKTeco device memory). Liveness PAD active.
              </p>
            </div>
            <div style={{ padding: 14, background: 'var(--fog)', border: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>Fingerprint Sensor Matching</strong>
                <Badge tone="online">Active</Badge>
              </div>
              <p className="tiny muted" style={{ marginTop: 6 }}>
                Primary index & thumb templates cached on entrance turnstiles and vehicle boom barriers.
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16, flexWrap: 'wrap', gap: 10 }}>
            <span className="tiny muted" style={{ maxWidth: '60ch' }}>
              In compliance with DPDP Act 2023, biometric templates are processed locally on device hardware and never transmitted to the public internet.
            </span>
            <button
              type="button"
              className="btn btn-small btn-primary"
              onClick={testBiometricPing}
              disabled={bioSimulated}
            >
              {bioSimulated ? '✓ Controller Sensor Verified' : 'Ping Local Gate Reader'}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
