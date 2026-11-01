export type VisitorCategory =
  | 'RELATIVE'
  | 'FRIEND'
  | 'DELIVERY'
  | 'CAB'
  | 'MAINTENANCE'
  | 'OTHER';

export interface SelfRegisterVisitorRequest {
  societyId: string;
  flatId: string;
  visitorName: string;
  visitorPhone?: string;
  category: VisitorCategory;
  vehicle?: string;
  purpose?: string;
  expectedDurationMinutes?: number;
}

export interface SelfRegisterVisitorResponse {
  passId: string;
  societyId: string;
  status: 'ACTIVE' | 'PENDING_APPROVAL';
  category: VisitorCategory;
  visitor: {
    id: string;
    name: string;
    phone: string | null;
  };
  flat: {
    id: string;
    buildingName: string;
    flatNumber: string;
  };
  validFrom: string;
  validUntil: string;
  maxUses: number;
  credentials: {
    pin: string;
    qrToken: string;
  } | null;
  accessPoints: Array<{
    id: string;
    name: string;
    type: string;
  }>;
  message: string;
  requiresHostApproval: boolean;
}
