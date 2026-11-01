import type {
  VisitorCategory,
  SelfRegisterVisitorRequest,
  SelfRegisterVisitorResponse,
} from '@societyos/shared-types';

export type {
  VisitorCategory,
  SelfRegisterVisitorRequest,
  SelfRegisterVisitorResponse,
};

export interface VisitorRegistrationFormState {
  societyId: string;
  flatId: string;
  visitorName: string;
  visitorPhone: string;
  category: VisitorCategory;
  vehicle: string;
  purpose: string;
  durationMinutes: number;
}
