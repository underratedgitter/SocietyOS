export type ResidentRelationship = 'OWNER' | 'TENANT' | 'FAMILY';

export interface RegisterUserRequest {
  name: string;
  email: string;
  password: string;
  phone?: string;
  societyId: string;
  flatId?: string;
  relationship?: ResidentRelationship;
}

export interface RegisterUserResponse {
  user: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    isPlatformAdmin: boolean;
    mustChangePassword: boolean;
  };
  expiresIn: number;
  society: {
    id: string;
    name: string;
  };
  flat?: {
    id: string;
    flatNumber: string;
    buildingName: string;
    relationship: ResidentRelationship;
  };
}
