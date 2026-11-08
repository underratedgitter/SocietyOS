'use client';

import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

/** QR tokens are 24 random bytes, base64url-encoded (32 chars). */
const QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

type PassLinkState = { status: 'loading' } | { status: 'ready'; token: string } | { status: 'invalid' };

/**
 * Public page opened from the visitor's SMS/WhatsApp link. The QR token travels in the URL
 * fragment (#qr=...), which browsers never send to a server, so it is read and rendered here
 * on the device only. No API call is made and nothing is stored.
 */
export default function VisitorPassPage() {
  const [state, setState] = useState<PassLinkState>({ status: 'loading' });

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('qr');
    setState(token && QR_TOKEN_PATTERN.test(token) ? { status: 'ready', token } : { status: 'invalid' });
  }, []);

  return (
    <main className="login-shell">
      <section className="login-scene" aria-label="SocietyOS visitor pass">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true" />
          <div className="brand-name" style={{ fontSize: 22 }}>
            SocietyOS
          </div>
        </div>
        <div className="login-copy">
          <h1 className="login-title display">Your visitor pass</h1>
          {state.status === 'ready' ? (
            <>
              <p className="login-lede">Show this QR code at the security gate. You can also use the PIN from your message.</p>
              <div
                style={{ background: '#fff', padding: 16, borderRadius: 12, display: 'inline-block', marginTop: 16 }}
                role="img"
                aria-label="Gate entry QR code"
              >
                <QRCodeSVG value={state.token} size={220} level="M" includeMargin={false} />
              </div>
              <p className="small" style={{ marginTop: 12, opacity: 0.7 }}>
                Do not share this link. Anyone with it can use your pass until it expires.
              </p>
            </>
          ) : state.status === 'invalid' ? (
            <p className="login-lede">
              This link is incomplete. Open the full link from your SMS or WhatsApp message, or use the PIN at the gate.
            </p>
          ) : null}
        </div>
      </section>
    </main>
  );
}
