'use client';

import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, ExternalLink, MapPin, Share2, ShieldCheck } from 'lucide-react';
import { Modal } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import type { SelfRegisterVisitorResponse } from './types';

export function VisitorPassModal({
  pass,
  onClose,
}: {
  pass: SelfRegisterVisitorResponse;
  onClose: () => void;
}) {
  const [copiedPin, setCopiedPin] = useState(false);
  const [shared, setShared] = useState(false);

  const cleanName = pass.visitor.name.replace(/\s*\[.*?\]/, '').trim();
  const shareText = [
    '🏛️ *SocietyOS Visitor Gate Pass*',
    `👤 *Guest / Relative:* ${cleanName}`,
    pass.visitor.phone ? `📱 *Phone:* ${pass.visitor.phone}` : null,
    `📍 *Visiting:* ${pass.flat.buildingName} · Flat ${pass.flat.flatNumber}`,
    `🏷️ *Category:* ${pass.category}`,
    `⏱️ *Valid Until:* ${formatDateTime(pass.validUntil)}`,
    '',
    pass.credentials?.pin ? `🔑 *Entry PIN:* ${pass.credentials.pin}` : null,
    pass.credentials
      ? '👉 Type this 6-digit PIN on the boom barrier or gate keypad, or scan this QR token under the camera for entry.'
      : '👉 Access credentials will be issued immediately upon resident approval.',
  ]
    .filter(Boolean)
    .join('\n');

  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`;

  async function copyPin() {
    if (!pass.credentials?.pin) return;
    await navigator.clipboard.writeText(pass.credentials.pin);
    setCopiedPin(true);
    setTimeout(() => setCopiedPin(false), 2000);
  }

  async function handleNativeShare() {
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({
          title: `Gate Pass for ${cleanName}`,
          text: shareText,
        });
        setShared(true);
        setTimeout(() => setShared(false), 2500);
      } catch {
        // user cancelled or share failed
      }
    }
  }

  return (
    <Modal title="Gate Entry Pass Issued" onClose={onClose}>
      <div className="stack" style={{ gap: 16 }}>
        {pass.requiresHostApproval ? (
          <div className="notice" style={{ background: 'var(--amber-soft)', borderColor: 'var(--amber)' }}>
            <strong>Pass Pending Resident Approval</strong>
            <span style={{ marginTop: 2, fontSize: 12 }}>
              A notification has been sent to Flat {pass.flat.flatNumber}. Once the resident approves,
              your credentials will activate immediately at the gate.
            </span>
          </div>
        ) : (
          <div className="notice" style={{ background: '#ecfdf5', borderColor: '#a7f3d0', color: '#065f46' }}>
            <Check size={16} color="#059669" style={{ flex: 'none', marginTop: 1 }} />
            <span>
              <strong>Gate pass is active!</strong> You may enter through any authorized vehicle barrier
              or pedestrian turnstile.
            </span>
          </div>
        )}

        {/* QR Code Presentation (Only for Approved / Active Passes) */}
        {pass.credentials ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: 20,
              background: 'var(--fog)',
              border: '1px solid var(--line)',
              borderRadius: 12,
              textAlign: 'center',
            }}
          >
            <div
              style={{
                padding: 14,
                background: '#FFFFFF',
                borderRadius: 10,
                boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
              }}
            >
              <QRCodeSVG value={pass.credentials.qrToken} size={180} level="M" />
            </div>

            <div style={{ marginTop: 16, width: '100%' }}>
              <span className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: 1.2, fontWeight: 700 }}>
                6-Digit Touchscreen Keypad PIN
              </span>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  marginTop: 6,
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
                  {pass.credentials.pin}
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
        ) : null}

        {/* Destination & Window Info */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{ padding: 12, background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: 'var(--charcoal)' }}>
              <MapPin size={13} color="var(--amber)" /> Destination
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4 }}>
              {pass.flat.buildingName} · Flat {pass.flat.flatNumber}
            </div>
            <div className="tiny muted">{pass.category} Pass</div>
          </div>

          <div style={{ padding: 12, background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: 'var(--charcoal)' }}>
              <ShieldCheck size={13} color="var(--amber)" /> Valid Until
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4 }}>
              {formatDateTime(pass.validUntil)}
            </div>
            <div className="tiny muted">{pass.maxUses} total gate uses</div>
          </div>
        </div>

        {/* Gate Reader Details */}
        <div>
          <span className="tiny muted" style={{ fontWeight: 700, letterSpacing: 0.5 }}>
            Authorized Gate Terminals:
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {pass.accessPoints.map((gate) => (
              <span
                key={gate.id}
                style={{
                  fontSize: 11,
                  padding: '4px 8px',
                  background: 'var(--fog)',
                  border: '1px solid var(--line)',
                  borderRadius: 4,
                }}
              >
                ✓ {gate.name}
              </span>
            ))}
          </div>
        </div>

        {/* Share & Actions */}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <a
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn"
            style={{ flex: 1, textDecoration: 'none', justifyContent: 'center' }}
          >
            <Share2 size={15} color="#25D366" /> Share via WhatsApp
          </a>

          {typeof navigator !== 'undefined' && 'share' in navigator ? (
            <button
              type="button"
              className="btn"
              onClick={handleNativeShare}
              style={{ flex: 1 }}
            >
              <ExternalLink size={15} /> {shared ? 'Shared!' : 'Share Pass'}
            </button>
          ) : null}

          <button
            type="button"
            className="btn btn-primary"
            onClick={onClose}
            style={{ flex: 1 }}
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
