'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { Check, Copy, Inbox, X } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { copyText, passTone, reasonLabel, titleCase } from '@/lib/format';
import type { PassStatus } from '@/lib/types';

export function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function PassBadge({ status }: { status: PassStatus | string }) {
  const label = status === 'PENDING_APPROVAL' ? 'Awaiting approval' : titleCase(status);
  return <Badge tone={passTone(status)}>{label}</Badge>;
}

export function DecisionBadge({ decision }: { decision: 'AUTHORIZED' | 'DENIED' }) {
  return <Badge tone={decision === 'AUTHORIZED' ? 'authorized' : 'denied'}>{decision === 'AUTHORIZED' ? 'Allowed' : 'Denied'}</Badge>;
}

export function ReasonText({ code }: { code: string }) {
  return <span className="small muted">{reasonLabel(code)}</span>;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-head">
          <h2 className="modal-title" id={titleId}>
            {title}
          </h2>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </section>
    </div>
  );
}

export function LoadingScreen() {
  return (
    <div className="loading-screen" role="status" aria-label="Loading SocietyOS">
      <div className="loader" />
    </div>
  );
}

export function EmptyState({ title, copy, action }: { title: string; copy: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <Inbox size={22} strokeWidth={1.4} style={{ margin: '0 auto 8px' }} />
      <div className="empty-title">{title}</div>
      <p className="small muted" style={{ maxWidth: '48ch', margin: '0 auto' }}>
        {copy}
      </p>
      {action ? <div style={{ marginTop: 14 }}>{action}</div> : null}
    </div>
  );
}

export function Notice({ children, danger }: { children: ReactNode; danger?: boolean }) {
  return <div className={`notice ${danger ? 'danger' : ''}`}>{children}</div>;
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn btn-small"
      type="button"
      onClick={async () => {
        await copyText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? 'Copied' : label}
    </button>
  );
}

export function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">{title}</h2>
          {description ? <p className="hint" style={{ marginTop: 4 }}>{description}</p> : null}
        </div>
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Toast({
  message,
  error,
  onClose,
}: {
  message: string;
  error?: boolean;
  onClose: () => void;
}) {
  return (
    <div className={`toast ${error ? 'error' : ''}`} role="status">
      <div>
        <div className="toast-title">{error ? 'Something went wrong' : 'Done'}</div>
        <div className="toast-copy">{message}</div>
      </div>
      <button
        className="icon-btn"
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        style={{ background: 'transparent', borderColor: 'rgba(255,255,255,0.2)', color: 'inherit' }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return 'Too many attempts. Wait a moment and try again.';
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Try again.';
}

export function CredentialReveal({
  title = 'Shown once',
  rows,
  note,
}: {
  title?: string;
  rows: { label: string; value: string }[];
  note?: string;
}) {
  return (
    <div className="credential-callout">
      <div className="tiny muted" style={{ marginBottom: 4 }}>
        {title}
      </div>
      {rows.map((row) => (
        <div className="credential-value" key={row.label}>
          <span>
            <span className="tiny muted" style={{ marginRight: 10 }}>
              {row.label}
            </span>{' '}
            {row.value}
          </span>
          <CopyButton value={row.value} />
        </div>
      ))}
      {note ? <p className="hint" style={{ marginTop: 8 }}>{note}</p> : null}
    </div>
  );
}
