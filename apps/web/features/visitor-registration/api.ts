import { apiRequest } from '@/lib/api';
import type {
  PublicFlatSummary,
  PublicSocietySummary,
} from '@/features/user-registration/types';
import type {
  SelfRegisterVisitorRequest,
  SelfRegisterVisitorResponse,
} from './types';

export async function fetchPublicSocieties(): Promise<PublicSocietySummary[]> {
  return apiRequest<PublicSocietySummary[]>('/api/v1/public/societies', { skipRefresh: true });
}

export async function fetchPublicFlats(societyId: string): Promise<PublicFlatSummary[]> {
  return apiRequest<PublicFlatSummary[]>(`/api/v1/public/societies/${societyId}/flats`, { skipRefresh: true });
}

export async function submitVisitorSelfRegistration(
  payload: SelfRegisterVisitorRequest,
): Promise<SelfRegisterVisitorResponse> {
  return apiRequest<SelfRegisterVisitorResponse>('/api/v1/visitors/self-register', {
    method: 'POST',
    skipRefresh: true,
    body: JSON.stringify(payload),
  });
}
