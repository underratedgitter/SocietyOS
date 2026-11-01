'use client';

import type { ComponentType, ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Building2, Home, LogOut, Radio, Shield, Sliders } from 'lucide-react';
import { roleForSociety, userRoles, useSession } from './session-provider';
import { roleLabel } from '@/lib/format';
import type { Role, Session, SocietySummary } from '@/lib/types';

export interface NavItem {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}

const PORTAL_CONFIG: Record<
  Role,
  { label: string; path: string; icon: ComponentType<{ size?: number; strokeWidth?: number }> }
> = {
  RESIDENT: { label: 'Resident Portal', path: '/resident', icon: Home },
  GUARD: { label: 'Guard Station', path: '/guard', icon: Shield },
  SOCIETY_ADMIN: { label: 'Society Admin', path: '/admin', icon: Building2 },
  PLATFORM_ADMIN: { label: 'Platform Ops', path: '/platform', icon: Sliders },
};

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
  const router = useRouter();
  const pathname = usePathname();
  const activeSociety = societies.find((society) => society.id === activeSocietyId);
  const role = roleForSociety(session, activeSocietyId);

  const roles = userRoles(session);
  const availablePortals = (['RESIDENT', 'GUARD', 'SOCIETY_ADMIN', 'PLATFORM_ADMIN'] as Role[])
    .filter((r) => roles.includes(r))
    .map((r) => PORTAL_CONFIG[r]);
  const currentPortal = availablePortals.find((p) => pathname.startsWith(p.path));

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
        {availablePortals.length > 1 && (
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <div className="rail-label">Portals</div>
            <nav className="rail-nav" aria-label="Portal switcher">
              {availablePortals.map((portal) => {
                const Icon = portal.icon;
                const isCurrent = pathname.startsWith(portal.path);
                return (
                  <Link
                    key={portal.path}
                    href={portal.path}
                    className={`rail-link ${isCurrent ? 'active' : ''}`}
                    aria-current={isCurrent ? 'page' : undefined}
                    style={{ textDecoration: 'none' }}
                  >
                    <Icon size={16} strokeWidth={1.8} />
                    {portal.label}
                  </Link>
                );
              })}
            </nav>
          </div>
        )}
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
          <div className="topbar-left" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
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
            {availablePortals.length > 1 && (
              <div style={{ borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: 14 }}>
                <div className="context-label">Portal</div>
                <select
                  className="society-switch"
                  value={currentPortal?.path || availablePortals[0].path}
                  onChange={(event) => router.push(event.target.value)}
                  aria-label="Switch portal"
                >
                  {availablePortals.map((portal) => (
                    <option key={portal.path} value={portal.path}>
                      {portal.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
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
