import type {
  RelativeMember,
  RegisterRelativeRequest,
  QuickPassRequest,
} from '@societyos/shared-types';

export type {
  RelativeMember,
  RegisterRelativeRequest,
  QuickPassRequest,
};

export interface QuickPassResult {
  pass: {
    id: string;
    societyId: string;
    status: string;
    category: string;
    visitor: {
      id: string;
      name: string;
      phone: string | null;
    };
    flat: {
      id: string;
      building: string;
      flatNumber: string;
    };
    validFrom: string;
    validUntil: string;
    maxUses: number;
    usedCount: number;
  };
  credentials: {
    pin: string;
    qrToken: string;
  };
}
