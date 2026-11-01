import { apiRequest } from '@/lib/api';
import type {
  PublicSocietySummary,
  PublicFlatSummary,
  RegisterUserRequest,
  RegisterUserResponse,
} from './types';

export async function fetchPublicSocieties(): Promise<PublicSocietySummary[]> {
  return apiRequest<PublicSocietySummary[]>('/api/v1/public/societies', { skipRefresh: true });
}

export async function fetchPublicFlats(societyId: string): Promise<PublicFlatSummary[]> {
  return apiRequest<PublicFlatSummary[]>(`/api/v1/public/societies/${societyId}/flats`, { skipRefresh: true });
}

export async function submitUserRegistration(
  payload: RegisterUserRequest,
): Promise<RegisterUserResponse> {
  return apiRequest<RegisterUserResponse>('/api/v1/auth/register', {
    method: 'POST',
    skipRefresh: true,
    body: JSON.stringify(payload),
  });
}
