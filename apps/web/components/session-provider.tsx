'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiRequest, refreshSession } from '@/lib/api';
import type { Role, Session, SocietySummary } from '@/lib/types';

interface LoginResponse {
  user: Session['user'];
}

interface SessionContextValue {
  session: Session | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<Session>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  updatePassword: (currentPassword: string, newPassword: string) => Promise<Session>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async (): Promise<Session | null> => {
    try {
      return await apiRequest<Session>('/api/v1/auth/me', { skipRefresh: true });
    } catch {
      const refreshed = await refreshSession();
      if (!refreshed) return null;
      try {
        return await apiRequest<Session>('/api/v1/auth/me', { skipRefresh: true });
      } catch {
        return null;
      }
    }
  }, []);

  const reload = useCallback(async () => {
    const next = await loadMe();
    setSession(next);
    setLoading(false);
  }, [loadMe]);

  useEffect(() => {
    void reload();
    const onUnauthorized = () => {
      setSession(null);
      const path = window.location.pathname;
      if (
        !path.startsWith('/login') &&
        !path.startsWith('/kiosk') &&
        !path.startsWith('/register') &&
        !path.startsWith('/visitor-register')
      ) {
        window.location.assign('/login');
      }
    };
    window.addEventListener('societyos:unauthorized', onUnauthorized);
    return () => window.removeEventListener('societyos:unauthorized', onUnauthorized);
  }, [reload]);

  const login = useCallback(async (email: string, password: string): Promise<Session> => {
    await apiRequest<LoginResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      skipRefresh: true,
    });
    const next = await loadMe();
    if (!next) throw new Error('Session could not be established');
    setSession(next);
    setLoading(false);
    return next;
  }, [loadMe]);

  const logout = useCallback(async () => {
    try {
      await apiRequest('/api/v1/auth/logout', {
        method: 'POST',
        body: '{}',
        skipRefresh: true,
      });
    } finally {
      setSession(null);
      window.location.assign('/login');
    }
  }, []);

  const updatePassword = useCallback(
    async (currentPassword: string, newPassword: string): Promise<Session> => {
      await apiRequest('/api/v1/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
        skipRefresh: true,
      });
      const next = await loadMe();
      if (!next) throw new Error('Session could not be refreshed');
      setSession(next);
      return next;
    },
    [loadMe],
  );

  const value = useMemo(
    () => ({ session, loading, login, logout, reload, updatePassword }),
    [session, loading, login, logout, reload, updatePassword],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}

export function roleForSociety(session: Session | null, societyId: string | undefined): Role | null {
  if (!session || !societyId) return null;
  return session.memberships.find((membership) => membership.society.id === societyId)?.role ?? null;
}

export function societyList(session: Session | null): SocietySummary[] {
  if (!session) return [];
  return session.memberships
    .filter((membership) => membership.status === 'ACTIVE')
    .map((membership) => ({
      id: membership.society.id,
      name: membership.society.name,
      slug: membership.society.slug,
      timezone: membership.society.timezone,
      role: membership.role,
      createdAt: '',
    }));
}

export function primaryRole(session: Session | null): Role | null {
  if (!session) return null;
  if (session.user.isPlatformAdmin) return 'PLATFORM_ADMIN';
  const roles = session.memberships.filter((membership) => membership.status === 'ACTIVE').map((membership) => membership.role);
  if (roles.includes('SOCIETY_ADMIN')) return 'SOCIETY_ADMIN';
  if (roles.includes('GUARD')) return 'GUARD';
  if (roles.includes('RESIDENT')) return 'RESIDENT';
  return null;
}

export function homeFor(session: Session | null): string {
  const role = primaryRole(session);
  if (role === 'PLATFORM_ADMIN') return '/platform';
  if (role === 'SOCIETY_ADMIN') return '/admin';
  if (role === 'GUARD') return '/guard';
  if (role === 'RESIDENT') return '/resident';
  return '/login';
}
