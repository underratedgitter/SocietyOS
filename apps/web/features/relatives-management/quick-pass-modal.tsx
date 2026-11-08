'use client';

import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, Share2, Zap } from 'lucide-react';
import { Modal, Notice, errorMessage } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { issueQuickPass } from './api';
import type { QuickPassResult, RelativeMember } from './types';

export function QuickPassModal({
  flatId,
  relative,
  onClose,
  onPassCreated,
}: {
  flatId: string;
  relative: RelativeMember;
  onClose: () => void;
  onPassCreated: (result: QuickPassResult) => void;
}) {
  const [validHours, setValidHours] = useState(24);
  const [maxUses, setMaxUses] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<QuickPassResult | null>(null);
  const [copiedPin, setCopiedPin] = useState(false);

  async function handleGenerate() {
    setError('');
    setSubmitting(true);
    try {
      const generated = await issueQuickPass(flatId, relative.visitorId, {
        validHours,
        maxUses,
      });
      setResult(generated);
      onPassCreated(generated);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyPin() {
    if (!result) return;
    await navigator.clipboard.writeText(result.credentials.pin);
    setCopiedPin(true);
    setTimeout(() => setCopiedPin(false), 2000);
  }

  const shareText = result
    ? [
        '🏛️ *SocietyOS Relative Entry Pass*',
        `👤 *Family Member:* ${relative.name} (${relative.relation})`,
        relative.phone ? `📱 *Phone:* ${relative.phone}` : null,
        `📍 *Flat:* ${result.pass.flat.building} · Flat ${result.pass.flat.flatNumber}`,
        `⏱️ *Valid Until:* ${formatDateTime(result.pass.validUntil)}`,
        '',
        `🔑 *Gate PIN:* ${result.credentials.pin}`,
        '👉 Punch this 6-digit PIN on the boom barrier touchscreen or scan the QR token for instant gate opening.',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const cleanPhone = relative.phone ? relative.phone.replace(/\D/g, '') : '';
  const whatsappUrl = cleanPhone.length >= 10
    ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(shareText)}`
    : `https://wa.me/?text=${encodeURIComponent(shareText)}`;

  return (
    <Modal
      title={result ? 'Gate Pass Ready to Share' : `Issue Fast Pass for ${relative.name}`}
      onClose={onClose}
    >
      <div className="stack" style={{ gap: 14 }}>
        {error ? <Notice danger>{error}</Notice> : null}

        {!result ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, background: 'var(--fog)', borderRadius: 8 }}>
              <div>
                <strong>{relative.name}</strong>
                <div className="tiny muted">{relative.relation} {relative.phone ? `· ${relative.phone}` : ''}</div>
              </div>
              <span className="badge" style={{ background: 'var(--amber-soft)', color: 'var(--amber-ink)', fontWeight: 700 }}>
                Trusted Family
              </span>
            </div>

            <div className="field">
              <label className="label">Validity Window</label>
              <div className="check-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {[
                  { hours: 24, label: '24 Hours' },
                  { hours: 48, label: '48 Hours' },
                  { hours: 72, label: '3 Days' },
                  { hours: 168, label: '7 Days' },
                ].map((item) => {
                  const active = validHours === item.hours;
                  return (
                    <button
                      type="button"
                      key={item.hours}
                      className="preset-pill"
                      style={{
                        background: active ? 'var(--ink)' : 'var(--paper)',
                        color: active ? '#FFFFFF' : 'var(--charcoal)',
                        borderColor: active ? 'var(--ink)' : 'var(--line)',
                        fontWeight: active ? 700 : 500,
                      }}
                      onClick={() => setValidHours(item.hours)}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="field">
              <label className="label" htmlFor="pass-max-uses">Maximum Gate Entries</label>
              <input
                className="input"
                id="pass-max-uses"
                type="number"
                min={1}
                max={20}
                value={maxUses}
                onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value)))}
              />
              <span className="tiny muted">Number of times this pass can open barriers during the visit.</span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleGenerate}
                disabled={submitting}
              >
                <Zap size={14} />
                {submitting ? 'Generating…' : 'Generate Pass & PIN'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                padding: 16,
                background: 'var(--fog)',
                border: '1px solid var(--line)',
                borderRadius: 12,
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  padding: 12,
                  background: '#FFFFFF',
                  borderRadius: 10,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
                }}
              >
                <QRCodeSVG value={result.credentials.qrToken} size={170} level="M" />
              </div>

              <div style={{ marginTop: 14, width: '100%' }}>
                <span className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: 1.2, fontWeight: 700 }}>
                  6-Digit Keypad PIN
                </span>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 10,
                    marginTop: 4,
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: 32,
                      fontWeight: 800,
                      letterSpacing: 4,
                      color: 'var(--primary)',
                    }}
                  >
                    {result.credentials.pin}
                  </span>
                  <button
                    type="button"
                    className="btn-ghost btn-small"
                    onClick={copyPin}
                    aria-label="Copy PIN"
                    title="Copy PIN"
                  >
                    {copiedPin ? <Check size={16} color="var(--primary)" /> : <Copy size={16} />}
                  </button>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', padding: 12, background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 13 }}>
              <span>Valid Until: <strong>{formatDateTime(result.pass.validUntil)}</strong></span>
              <span>Entries: <strong>{result.pass.maxUses} uses</strong></span>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <a
                href={whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn"
                style={{ flex: 1, textDecoration: 'none', justifyContent: 'center' }}
              >
                <Share2 size={15} color="#25D366" /> Share via WhatsApp
              </a>
              <button type="button" className="btn btn-primary" onClick={onClose} style={{ flex: 1 }}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
