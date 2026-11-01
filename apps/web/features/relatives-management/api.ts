import { apiRequest } from '@/lib/api';
import type {
  QuickPassRequest,
  QuickPassResult,
  RegisterRelativeRequest,
  RelativeMember,
} from './types';

export async function fetchRelatives(flatId: string): Promise<RelativeMember[]> {
  return apiRequest<RelativeMember[]>(`/api/v1/flats/${flatId}/relatives`);
}

export async function registerRelative(
  flatId: string,
  payload: RegisterRelativeRequest,
): Promise<{
  relative: RelativeMember;
  initialPass?: {
    id: string;
    status: string;
    validFrom: string;
    validUntil: string;
    maxUses: number;
    credentials: {
      pin: string;
      qrToken: string;
    };
  };
}> {
  return apiRequest(`/api/v1/flats/${flatId}/relatives`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function issueQuickPass(
  flatId: string,
  visitorId: string,
  payload: QuickPassRequest = {},
): Promise<QuickPassResult> {
  return apiRequest<QuickPassResult>(
    `/api/v1/flats/${flatId}/relatives/${visitorId}/quick-pass`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );
}

export async function removeRelative(
  flatId: string,
  visitorId: string,
): Promise<{ ok: boolean }> {
  return apiRequest<{ ok: boolean }>(
    `/api/v1/flats/${flatId}/relatives/${visitorId}`,
    {
      method: 'DELETE',
    },
  );
}
