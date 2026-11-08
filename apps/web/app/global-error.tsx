'use client';

import { useEffect } from 'react';

// Replaces the root layout when it fails, so globals.css is not loaded: styles are inline.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'system-ui, sans-serif',
          background: '#eef3ed',
          color: '#0d2a24',
        }}
      >
        <title>SocietyOS</title>
        <main role="alert" style={{ textAlign: 'center', padding: 24 }}>
          <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>SocietyOS is unavailable</h1>
          <p style={{ margin: '0 0 16px', color: '#65786d' }}>An unexpected error occurred. Try again in a moment.</p>
          <button
            type="button"
            onClick={() => retry()}
            style={{
              padding: '9px 16px',
              borderRadius: 8,
              border: '1px solid #0d2a24',
              background: '#0d2a24',
              color: '#f5f9f2',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
