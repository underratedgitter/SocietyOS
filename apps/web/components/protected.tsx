'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { homeFor, userRoles, useSession } from './session-provider';
import type { Role } from '@/lib/types';
import { LoadingScreen } from './ui';

export function Protected({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { session, loading } = useSession();
  const router = useRouter();
  const activeRoles = userRoles(session);
  const authorized = activeRoles.some((role) => roles.includes(role));

  useEffect(() => {
    if (loading) return;
    if (!session) {
      router.replace('/login');
      return;
    }
    if (session.user.mustChangePassword) {
      router.replace('/change-password');
      return;
    }
    if (!authorized) {
      router.replace(homeFor(session));
    }
  }, [loading, session, authorized, router]);

  if (loading || !session || session.user.mustChangePassword || !authorized) {
    return <LoadingScreen />;
  }
  return <>{children}</>;
}
