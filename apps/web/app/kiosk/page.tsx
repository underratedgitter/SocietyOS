'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Delete,
  Fingerprint,
  KeyRound,
  Maximize2,
  ScanLine,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import { apiRequest } from '@/lib/api';
import type { AccessPoint, SocietySummary, VerifyResponse } from '@/lib/types';
import { reasonLabel } from '@/lib/format';
import { societyList, useSession } from '@/components/session-provider';
import { errorMessage } from '@/components/ui';
import { GateVisualizer, type VisualGateState } from '@/components/gate-visualizer';
import { playAuthorizedChime, playDeniedBuzzer, playKeypadClick } from '@/lib/sound';

type Mode = 'PIN' | 'QR' | 'BIOMETRIC';

export default function KioskPage() {
  const { session, loading } = useSession();
  const router = useRouter();
  const societies = useMemo<SocietySummary[]>(
    () =>
      societyList(session).filter(
        (society) => society.role === 'GUARD' || society.role === 'SOCIETY_ADMIN',
      ),
    [session],
  );
  const [societyId, setSocietyId] = useState('');
  const [accessPoints, setAccessPoints] = useState<AccessPoint[]>([]);
  const [gateId, setGateId] = useState('');
  const [clock, setClock] = useState('');
  const [mode, setMode] = useState<Mode>('PIN');
  const [pin, setPin] = useState('');
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [gateVisualState, setGateVisualState] = useState<VisualGateState>('CLOSED');
  const [biometricScanning, setBiometricScanning] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!session) {
      router.replace('/login');
      return;
    }
    if (session.user.mustChangePassword) {
      router.replace('/change-password');
      return;
    }
    if (!societies.length) return;
    if (!societies.some((society) => society.id === societyId)) {
      setSocietyId(societies[0].id);
    }
  }, [loading, session, router, societies, societyId]);

  useEffect(() => {
    if (!societyId) return;
    let active = true;
    apiRequest<AccessPoint[]>(`/api/v1/societies/${societyId}/access-points`)
      .then((points) => {
        if (!active) return;
        setAccessPoints(points);
        const stored = window.localStorage.getItem(`societyos:gate:${societyId}`);
        const next = points.find((point) => point.id === stored) ?? points[0];
        setGateId(next?.id ?? '');
      })
      .catch((caught) => {
        if (active) setError(errorMessage(caught));
      });
    return () => {
      active = false;
    };
  }, [societyId]);

  useEffect(() => {
    const tick = () =>
      setClock(
        new Intl.DateTimeFormat('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          timeZone: societies.find((society) => society.id === societyId)?.timezone || 'Asia/Kolkata',
        }).format(new Date()),
      );
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [societies, societyId]);

  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(
      () => {
        setResult(null);
        setGateVisualState('CLOSED');
      },
      result.decision === 'AUTHORIZED' ? 7000 : 9000,
    );
    return () => window.clearTimeout(timer);
  }, [result]);

  const selectGate = useCallback(
    (id: string) => {
      setGateId(id);
      if (societyId) window.localStorage.setItem(`societyos:gate:${societyId}`, id);
      setPin('');
      setQr('');
      setResult(null);
      setError('');
      setGateVisualState('CLOSED');
    },
    [societyId],
  );

  async function verify(credentialType: Mode, credential: string) {
    if (!gateId) return setError('Select a gate first.');
    if (credential.trim().length < 4) return setError('Enter a credential.');
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await apiRequest<VerifyResponse>('/api/v1/access/manual-verify', {
        method: 'POST',
        body: JSON.stringify({ accessPointId: gateId, credentialType, credential: credential.trim() }),
      });
      setResult(response);
      setPin('');
      setQr('');

      if (response.decision === 'AUTHORIZED') {
        playAuthorizedChime();
        setGateVisualState('OPENING');
        setTimeout(() => setGateVisualState('OPEN'), 500);
        setTimeout(() => setGateVisualState('CLOSING'), 4800);
        setTimeout(() => setGateVisualState('CLOSED'), 6400);
      } else {
        playDeniedBuzzer();
        setGateVisualState('CLOSED');
      }
    } catch (caught) {
      playDeniedBuzzer();
      setError(errorMessage(caught));
      setGateVisualState('CLOSED');
    } finally {
      setBusy(false);
      setBiometricScanning(false);
    }
  }

  function simulateBiometric() {
    if (busy || biometricScanning) return;
    setBiometricScanning(true);
    playKeypadClick();
    setError('');
    setResult(null);
    setTimeout(() => {
      void verify('BIOMETRIC', 'FINGERPRINT_RESIDENT_101');
    }, 1100);
  }

  function press(key: string) {
    if (busy) return;
    playKeypadClick();
    setError('');
    setResult(null);
    setPin((current) => (current + key).slice(0, 6));
  }

  function backspace() {
    playKeypadClick();
    setError('');
    setResult(null);
    setPin((current) => current.slice(0, -1));
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen().catch(() => undefined);
    } else {
      void document.exitFullscreen().catch(() => undefined);
    }
  }

  if (loading || !session) {
    return (
      <div className="kiosk-shell">
        <div className="kiosk-body">
          <div className="loader" />
        </div>
      </div>
    );
  }

  if (!societies.length) {
    return (
      <div className="kiosk-shell">
        <div className="kiosk-body">
          <div className="kiosk-card">
            <div className="kiosk-title">No gate assigned</div>
            <p className="kiosk-sub">This account is not on a society security team.</p>
            <a className="btn" href="/guard" style={{ marginTop: 20 }}>
              Back to console
            </a>
          </div>
        </div>
      </div>
    );
  }

  const gate = accessPoints.find((point) => point.id === gateId);
  const society = societies.find((item) => item.id === societyId);

  return (
    <div className="kiosk-shell">
      <div className="kiosk-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span className="brand-mark" aria-hidden="true" />
          <span style={{ letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 600 }}>
            SocietyOS Gate Kiosk
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <span>{society?.name}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{clock}</span>
          <button
            className="btn btn-small"
            type="button"
            onClick={toggleFullscreen}
            style={{ color: 'inherit', borderColor: 'rgba(255,255,255,0.25)', background: 'transparent' }}
            title="Toggle fullscreen terminal"
          >
            <Maximize2 size={13} />
          </button>
          <a
            className="btn btn-small"
            href="/guard"
            style={{ color: 'inherit', borderColor: 'rgba(255,255,255,0.25)', background: 'transparent' }}
          >
            <ArrowLeft size={13} /> Console
          </a>
        </div>
      </div>

      <div className="kiosk-body">
        <div className="kiosk-card">
          {/* Live Gate Barrier Animation View */}
          <div style={{ marginBottom: 16 }}>
            <GateVisualizer
              state={gateVisualState}
              type={gate?.type || 'BOOM_BARRIER'}
              name={gate?.name || 'Gate Access Point'}
              location={gate?.location}
            />
          </div>

          {result ? (
            <div className={`kiosk-result ${result.decision === 'AUTHORIZED' ? 'ok' : 'bad'}`} role="status">
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                {result.decision === 'AUTHORIZED' ? <ShieldCheck size={34} /> : <ShieldAlert size={34} />}
                <div>
                  <div className="kiosk-title" style={{ fontSize: 34 }}>
                    {result.decision === 'AUTHORIZED' ? 'Entry Allowed' : 'Entry Denied'}
                  </div>
                  <div className="kiosk-sub">
                    {reasonLabel(result.reasonCode)}
                    {result.commandId ? ' · Gate opened, proceed through' : ''}
                  </div>
                </div>
              </div>
              <div className="kiosk-sub" style={{ marginTop: 14, fontSize: 12 }}>
                Event {result.accessEventId.slice(0, 8)} · Screen resets automatically
              </div>
              <button
                className="btn btn-small"
                type="button"
                style={{ marginTop: 16, color: 'inherit', borderColor: 'rgba(255,255,255,0.25)', background: 'transparent' }}
                onClick={() => {
                  setResult(null);
                  setGateVisualState('CLOSED');
                }}
              >
                Next Visitor
              </button>
            </div>
          ) : (
            <>
              <div className="kiosk-title">Gate check</div>
              <p className="kiosk-sub">
                {gate ? `${gate.name}${gate.location ? ` · ${gate.location}` : ''}` : 'Select an access point'}
              </p>

              <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
                {societies.length > 1 ? (
                  <select
                    className="society-switch"
                    style={{ flex: 1, color: 'inherit', borderColor: 'rgba(255,255,255,0.25)', background: 'rgba(255,255,255,0.06)' }}
                    value={societyId}
                    onChange={(event) => setSocietyId(event.target.value)}
                    aria-label="Society"
                  >
                    {societies.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <select
                  className="society-switch"
                  style={{ flex: 2, color: 'inherit', borderColor: 'rgba(255,255,255,0.25)', background: 'rgba(255,255,255,0.06)' }}
                  value={gateId}
                  onChange={(event) => selectGate(event.target.value)}
                  aria-label="Gate"
                >
                  {accessPoints.length === 0 ? <option value="">No gates configured</option> : null}
                  {accessPoints.map((point) => (
                    <option key={point.id} value={point.id}>
                      {point.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="tabs" style={{ marginTop: 18, borderColor: 'rgba(255,255,255,0.16)' }}>
                <button
                  type="button"
                  className={`tab ${mode === 'PIN' ? 'active' : ''}`}
                  style={{ color: 'inherit' }}
                  onClick={() => {
                    setMode('PIN');
                    setResult(null);
                  }}
                >
                  <KeyRound size={13} /> 6-Digit PIN
                </button>
                <button
                  type="button"
                  className={`tab ${mode === 'QR' ? 'active' : ''}`}
                  style={{ color: 'inherit' }}
                  onClick={() => {
                    setMode('QR');
                    setResult(null);
                  }}
                >
                  <ScanLine size={13} /> QR Token
                </button>
                <button
                  type="button"
                  className={`tab ${mode === 'BIOMETRIC' ? 'active' : ''}`}
                  style={{ color: 'inherit' }}
                  onClick={() => {
                    setMode('BIOMETRIC');
                    setResult(null);
                  }}
                >
                  <Fingerprint size={13} /> Resident Biometric
                </button>
              </div>

              {error ? (
                <div className="notice danger" style={{ marginTop: 16 }}>
                  {error}
                </div>
              ) : null}

              {mode === 'PIN' && (
                <>
                  <div className="pin-display" aria-label={`PIN entry, ${pin.length} of 6 digits`}>
                    {pin.padEnd(6, '·')}
                  </div>
                  <div className="keypad">
                    {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((key) => (
                      <button className="key" type="button" key={key} onClick={() => press(key)}>
                        {key}
                      </button>
                    ))}
                    <button className="key" type="button" onClick={() => setPin('')} aria-label="Clear">
                      <X size={20} />
                    </button>
                    <button className="key" type="button" onClick={() => press('0')}>
                      0
                    </button>
                    <button className="key" type="button" onClick={backspace} aria-label="Delete last digit">
                      <Delete size={20} />
                    </button>
                  </div>
                  <button
                    className="key amber"
                    type="button"
                    style={{ width: '100%', marginTop: 10, minHeight: 52 }}
                    disabled={pin.length !== 6 || busy || !gateId}
                    onClick={() => void verify('PIN', pin)}
                  >
                    {busy ? 'Verifying PIN…' : 'Verify PIN'}
                  </button>
                </>
              )}

              {mode === 'QR' && (
                <div style={{ marginTop: 16 }}>
                  <label className="label" htmlFor="kiosk-qr" style={{ color: 'rgba(255,255,255,0.65)' }}>
                    QR Token
                  </label>
                  <input
                    className="input"
                    id="kiosk-qr"
                    value={qr}
                    onChange={(event) => {
                      setQr(event.target.value.trim());
                      setError('');
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && qr.length >= 4) void verify('QR', qr);
                    }}
                    autoComplete="off"
                    autoFocus
                    placeholder="Scan or paste visitor QR token"
                    style={{
                      background: 'rgba(0,0,0,0.25)',
                      color: '#f1f6ee',
                      borderColor: 'rgba(255,255,255,0.25)',
                      marginTop: 6,
                    }}
                  />
                  <button
                    className="key amber"
                    type="button"
                    style={{ width: '100%', marginTop: 12, minHeight: 52 }}
                    disabled={qr.length < 4 || busy || !gateId}
                    onClick={() => void verify('QR', qr)}
                  >
                    {busy ? 'Scanning QR Token…' : 'Verify QR Token'}
                  </button>
                  <p className="kiosk-sub" style={{ fontSize: 12, marginTop: 12 }}>
                    Hardware 2D Barcode scanner automatically inputs into this field.
                  </p>
                </div>
              )}

              {mode === 'BIOMETRIC' && (
                <div className="biometric-box">
                  <div
                    className={`biometric-scanner-ring ${biometricScanning ? 'scanning' : ''}`}
                    onClick={simulateBiometric}
                    role="button"
                    tabIndex={0}
                    aria-label="Tap to scan biometric"
                  >
                    <Fingerprint size={48} color={biometricScanning ? '#34d399' : 'var(--amber)'} />
                    {biometricScanning && <div className="biometric-laser-line" />}
                  </div>
                  <div className="biometric-inst">
                    {biometricScanning ? 'Verifying live biometric template…' : 'Touch Reader or Look at Face Sensor'}
                  </div>
                  <div className="biometric-sub">
                    Suprema / ZKTeco Edge Reader with Local Template Matching & Liveness Check
                  </div>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={simulateBiometric}
                    disabled={biometricScanning || busy || !gateId}
                    style={{ marginTop: 16, borderColor: 'rgba(255,255,255,0.25)', background: 'rgba(255,255,255,0.08)', color: '#fff' }}
                  >
                    {biometricScanning ? 'Processing…' : 'Simulate Resident Touch ID Scan'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="kiosk-top" style={{ fontStyle: 'italic', fontSize: 12 }}>
        <span>Hardware abstracted controller with physical safety interlocks.</span>
        <span>Operator: {session.user.name}</span>
      </div>
    </div>
  );
}
