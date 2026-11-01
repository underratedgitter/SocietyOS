export type RelativeRelationType =
  | 'PARENT'
  | 'SIBLING'
  | 'SPOUSE'
  | 'CHILD'
  | 'GRANDPARENT'
  | 'IN_LAWS'
  | 'COUSIN'
  | 'EXTENDED_FAMILY'
  | 'OTHER';

export interface RelativeMember {
  id: string;
  visitorId: string;
  societyId: string;
  flatId: string;
  name: string;
  phone?: string | null;
  relation: RelativeRelationType | string;
  defaultVehicle?: string | null;
  notes?: string | null;
  createdAt: string;
  lastVisitAt?: string | null;
  activePassCount: number;
}

export interface RegisterRelativeRequest {
  flatId: string;
  name: string;
  phone?: string;
  relation: RelativeRelationType | string;
  defaultVehicle?: string;
  notes?: string;
}

export interface QuickPassRequest {
  validHours?: number;
  maxUses?: number;
  gateIds?: string[];
  vehicle?: string;
}
