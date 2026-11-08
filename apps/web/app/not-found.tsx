import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="loading-screen">
      <div className="empty">
        <h1 className="empty-title">Page not found</h1>
        <p className="small muted" style={{ maxWidth: '48ch', margin: '0 auto' }}>
          The page you asked for does not exist or has moved.
        </p>
        <div style={{ marginTop: 14 }}>
          <Link className="btn btn-primary" href="/">
            Go to start
          </Link>
        </div>
      </div>
    </main>
  );
}
