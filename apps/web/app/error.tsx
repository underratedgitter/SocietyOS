'use client';

import { useEffect } from 'react';

export default function RouteError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  // Only the server-issued digest is shown; raw messages can carry internal details.
  const digest =
    error instanceof Error && 'digest' in error && typeof error.digest === 'string' ? error.digest : undefined;

  return (
    <main className="loading-screen">
      <div className="empty" role="alert">
        <div className="empty-title">Something went wrong</div>
        <p className="small muted" style={{ maxWidth: '48ch', margin: '0 auto' }}>
          This screen could not be loaded. Try again, or return to the start page.
        </p>
        {digest ? (
          <p className="tiny muted" style={{ marginTop: 8 }}>
            Reference: {digest}
          </p>
        ) : null}
        <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button className="btn btn-primary" type="button" onClick={() => retry()}>
            Try again
          </button>
          <a className="btn" href="/">
            Go to start
          </a>
        </div>
      </div>
    </main>
  );
}
