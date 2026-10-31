'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { homeFor, primaryRole, useSession } from './session-provider';
import type { Role } from '@/lib/types';
import { LoadingScreen } from './ui';

export function Protected({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { session, loading } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const role = primaryRole(session);

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
    if (role && !roles.includes(role)) {
      router.replace(homeFor(session));
    }
  }, [loading, session, role, roles, router]);

  if (loading || !session || session.user.mustChangePassword || !role || !roles.includes(role)) {
    return <LoadingScreen />;
  }
  return <>{children}</>;
}
