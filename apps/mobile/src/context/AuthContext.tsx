import React, { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, setAuthTokens } from '../api/client';
import type { FlatLink, Membership, Session, SocietyRef } from '../api/types';

export const DEMO_RESIDENTS = [
  { label: 'Resident 101 (Palm Grove)', email: 'resident.a1@societyos.dev', password: 'Society#2026' },
  { label: 'Resident 102 (Palm Grove)', email: 'resident.a2@societyos.dev', password: 'Society#2026' },
];

interface AuthContextType {
  session: Session | null;
  selectedFlat: FlatLink | null;
  selectedSociety: SocietyRef | null;
  loading: boolean;
  error: string | null;
  setSelectedFlat: (flat: FlatLink) => void;
  login: (email: string, password: string) => Promise<Session>;
  demoLogin: (email: string, password: string) => Promise<Session>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [selectedFlat, setSelectedFlat] = useState<FlatLink | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const selectedSociety: SocietyRef | null = selectedFlat
    ? {
        id: selectedFlat.building.societyId,
        name: session?.memberships.find((m) => m.society.id === selectedFlat.building.societyId)?.society.name ?? 'Society',
        slug: session?.memberships.find((m) => m.society.id === selectedFlat.building.societyId)?.society.slug ?? '',
        timezone: session?.memberships.find((m) => m.society.id === selectedFlat.building.societyId)?.society.timezone ?? 'Asia/Kolkata',
      }
    : (session?.memberships[0]?.society ?? null);

  const refreshProfile = async () => {
    try {
      const me = await api.getMe();
      setSession(me);
      if (me.flats.length > 0) {
        setSelectedFlat((prev) => (prev && me.flats.some((f) => f.id === prev.id) ? prev : me.flats[0]));
      }
    } catch {
      setSession(null);
      setSelectedFlat(null);
    }
  };

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const me = await api.getMe();
        if (isMounted) {
          setSession(me);
          if (me.flats.length > 0) {
            setSelectedFlat(me.flats[0]);
          }
        }
      } catch {
        // Not logged in or expired session
        if (isMounted) {
          setSession(null);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  const login = async (email: string, password: string): Promise<Session> => {
    setError(null);
    try {
      await api.login(email, password);
      const me = await api.getMe();
      setSession(me);
      if (me.flats.length > 0) {
        setSelectedFlat(me.flats[0]);
      }
      return me;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Login failed. Please check your credentials.';
      setError(msg);
      throw err;
    }
  };

  const demoLogin = async (email: string, password: string): Promise<Session> => {
    return login(email, password);
  };

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // Clear local state regardless
      setAuthTokens(null, null);
    } finally {
      setSession(null);
      setSelectedFlat(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        selectedFlat,
        selectedSociety,
        loading,
        error,
        setSelectedFlat,
        login,
        demoLogin,
        logout,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
