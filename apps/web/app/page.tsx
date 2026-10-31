'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { homeFor, useSession } from '@/components/session-provider';
import { LoadingScreen } from '@/components/ui';

export default function RootPage() {
  const { session, loading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!loading) router.replace(session ? homeFor(session) : '/login');
  }, [loading, session, router]);

  return <LoadingScreen />;
}
