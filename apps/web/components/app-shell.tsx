'use client';

import type { ComponentType, ReactNode } from 'react';
import { LogOut, Radio } from 'lucide-react';
import { roleForSociety, useSession } from './session-provider';
import { roleLabel } from '@/lib/format';
import type { Session, SocietySummary } from '@/lib/types';

export interface NavItem {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}

export function AppShell({
  session,
  societies,
  activeSocietyId,
  onSocietyChange,
  nav,
  active,
  onSelect,
  children,
}: {
  session: Session;
  societies: SocietySummary[];
  activeSocietyId?: string;
  onSocietyChange?: (id: string) => void;
  nav: NavItem[];
  active: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  const { logout } = useSession();
  const activeSociety = societies.find((society) => society.id === activeSocietyId);
  const role = roleForSociety(session, activeSocietyId);

  return (
    <div className="app-shell">
      <aside className="rail" aria-label="Primary navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <div className="brand-name">SocietyOS</div>
            <span className="brand-sub">Gate & residence</span>
          </div>
        </div>
        <div className="rail-label">Workspace</div>
        <nav className="rail-nav">
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={`rail-link ${active === item.id ? 'active' : ''}`}
                onClick={() => onSelect(item.id)}
                aria-current={active === item.id ? 'page' : undefined}
              >
                <Icon size={16} strokeWidth={1.8} />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="rail-foot">
          <div className="rail-user">
            <div className="rail-user-name">{session.user.name}</div>
            <div className="rail-user-role">{role ? roleLabel(role) : 'Platform operator'}</div>
            <button className="rail-link" type="button" onClick={() => void logout()} style={{ paddingLeft: 0, marginTop: 10 }}>
              <LogOut size={15} strokeWidth={1.8} />
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <div>
              <div className="context-label">Active society</div>
              {societies.length > 1 && onSocietyChange ? (
                <select
                  className="society-switch"
                  value={activeSocietyId}
                  onChange={(event) => onSocietyChange(event.target.value)}
                  aria-label="Switch society"
                >
                  {societies.map((society) => (
                    <option key={society.id} value={society.id}>
                      {society.name}
                    </option>
                  ))}
                </select>
              ) : (
                <div style={{ fontWeight: 650, fontSize: 13 }}>{activeSociety?.name ?? 'SocietyOS'}</div>
              )}
            </div>
          </div>
          <div className="topbar-right">
            <span className="topbar-chip">
              <Radio size={12} />
              Encrypted session
            </span>
            <span className="topbar-chip">
              <span className="live-dot" />
              Local time{' '}
              {new Intl.DateTimeFormat('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: activeSociety?.timezone || 'Asia/Kolkata',
              }).format(new Date())}
            </span>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
