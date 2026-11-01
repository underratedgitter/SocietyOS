import type {
  PublicSocietySummary,
  PublicFlatSummary,
  RegisterUserRequest,
  RegisterUserResponse,
} from '@societyos/shared-types';

export type {
  PublicSocietySummary,
  PublicFlatSummary,
  RegisterUserRequest,
  RegisterUserResponse,
};

export interface RegistrationFormState {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  phone: string;
  societyId: string;
  flatId: string;
  relationship: 'OWNER' | 'TENANT' | 'FAMILY';
}
