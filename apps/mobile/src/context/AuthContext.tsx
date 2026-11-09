import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  api,
  ApiError,
  getAccessToken,
  getRefreshToken,
  initStorage,
  isSessionRejected,
  setAuthTokens,
  setSessionExpiredHandler,
} from '../api/client';
import { mobileStorage } from '../api/storage';
import type { FlatLink, RegisterUserRequest, Session, SocietyRef } from '../api/types';

const isDev =
  (typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production') &&
  process.env.NODE_ENV !== 'production';

export const DEMO_RESIDENTS = isDev
  ? [
      { label: 'Resident 101 (Palm Grove)', email: 'resident.a1@societyos.dev', password: 'Society#2026' },
      { label: 'Resident 102 (Palm Grove)', email: 'resident.a2@societyos.dev', password: 'Society#2026' },
    ]
  : [];

interface AuthContextType {
  session: Session | null;
  selectedFlat: FlatLink | null;
  selectedSociety: SocietyRef | null;
  loading: boolean;
  error: string | null;
  isOffline: boolean;
  setSelectedFlat: (flat: FlatLink) => void;
  login: (email: string, password: string) => Promise<Session>;
  demoLogin: (email: string, password: string) => Promise<Session>;
  register: (payload: RegisterUserRequest) => Promise<Session>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [selectedFlat, setSelectedFlat] = useState<FlatLink | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState<boolean>(false);

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
      setIsOffline(false);
      void mobileStorage.saveCachedSession(me);
      if (me.flats.length > 0) {
        setSelectedFlat((prev) => (prev && me.flats.some((f) => f.id === prev.id) ? prev : me.flats[0]));
      }
    } catch (err) {
      if (!isSessionRejected(err)) {
        setIsOffline(true);
      } else {
        setSession(null);
        setSelectedFlat(null);
        setAuthTokens(null, null);
        void mobileStorage.clearAllCache();
        void mobileStorage.clearTokens();
      }
    }
  };

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        await initStorage();

        // Check for offline cached session first
        const cached = await mobileStorage.loadCachedSession<Session>();
        if (cached && isMounted) {
          setSession(cached);
          if (cached.flats?.length > 0) {
            setSelectedFlat(cached.flats[0]);
          }
        }

        // If no saved tokens, skip live check and render unauthenticated screen immediately
        if (!getAccessToken() && !getRefreshToken()) {
          if (isMounted) {
            setLoading(false);
          }
          return;
        }

        // Verify with live backend
        const me = await api.getMe();
        if (isMounted) {
          setSession(me);
          setIsOffline(false);
          void mobileStorage.saveCachedSession(me);
          if (me.flats.length > 0) {
            setSelectedFlat((prev) => (prev && me.flats.some((f) => f.id === prev.id) ? prev : me.flats[0]));
          }
        }
      } catch (err) {
        if (isMounted) {
          if (!isSessionRejected(err)) {
            setIsOffline(true);
            // Keep cached session if available during a network or server outage
          } else {
            setSession(null);
            setSelectedFlat(null);
            setAuthTokens(null, null);
            void mobileStorage.clearAllCache();
            void mobileStorage.clearTokens();
          }
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

  useEffect(() => {
    setSessionExpiredHandler(() => {
      setSession(null);
      setSelectedFlat(null);
      setIsOffline(false);
    });
    return () => setSessionExpiredHandler(null);
  }, []);

  const login = async (email: string, password: string): Promise<Session> => {
    setError(null);
    try {
      await api.login(email, password);
      const me = await api.getMe();
      setSession(me);
      setIsOffline(false);
      void mobileStorage.saveCachedSession(me);
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
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Demo accounts are disabled in production.');
    }
    return login(email, password);
  };

  const register = async (payload: RegisterUserRequest): Promise<Session> => {
    setError(null);
    try {
      await api.registerUser(payload);
      const me = await api.getMe();
      setSession(me);
      setIsOffline(false);
      void mobileStorage.saveCachedSession(me);
      if (me.flats.length > 0) {
        setSelectedFlat(me.flats[0]);
      }
      return me;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Registration failed. Please check details.';
      setError(msg);
      throw err;
    }
  };

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // Clear local state regardless
    } finally {
      setAuthTokens(null, null);
      setSession(null);
      setSelectedFlat(null);
      setIsOffline(false);
      void mobileStorage.clearTokens();
      void mobileStorage.clearAllCache();
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
        isOffline,
        setSelectedFlat,
        login,
        demoLogin,
        register,
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
