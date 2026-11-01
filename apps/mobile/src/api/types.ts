export type Role = 'PLATFORM_ADMIN' | 'SOCIETY_ADMIN' | 'RESIDENT' | 'GUARD';

export type PassStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'ACTIVE'
  | 'REVOKED'
  | 'EXPIRED'
  | 'EXHAUSTED'
  | 'SCHEDULED';

export type VisitorCategory = 'RELATIVE' | 'FRIEND' | 'DELIVERY' | 'CAB' | 'MAINTENANCE' | 'OTHER';

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
}

export interface SocietyRef {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

export interface Membership {
  society: SocietyRef;
  role: Role;
  status: 'ACTIVE' | 'INVITED' | 'DISABLED';
}

export interface FlatLink {
  id: string;
  flatNumber: string;
  building: {
    id: string;
    name: string;
    societyId: string;
  };
  relationship: 'OWNER' | 'TENANT' | 'FAMILY';
}

export interface Session {
  user: User;
  memberships: Membership[];
  flats: FlatLink[];
}

export interface AccessPoint {
  id: string;
  name: string;
  type: 'BOOM_BARRIER' | 'SLIDING_GATE' | 'DOOR_LOCK';
  location?: string | null;
}

export interface PassView {
  id: string;
  societyId: string;
  status: PassStatus;
  effectiveStatus: PassStatus;
  category: VisitorCategory;
  visitor: {
    id: string;
    name: string;
    phone: string | null;
  };
  flat: {
    id: string;
    flatNumber: string;
    building: string;
  };
  host: {
    id: string;
    name: string;
  };
  validFrom: string;
  validUntil: string;
  maxUses: number;
  usedCount: number;
  accessPoints: {
    id: string;
    name: string;
    type: string;
  }[];
  requiresApproval: boolean;
  createdAt: string;
  revokedAt?: string | null;
}

export interface PassPage {
  items: PassView[];
  nextCursor: string | null;
}

export interface PassWithCredentials {
  pass: PassView;
  credentials: {
    pin: string;
    qrToken: string;
  };
}

export interface Announcement {
  id: string;
  societyId: string;
  title: string;
  content: string;
  category: 'GENERAL' | 'EMERGENCY' | 'MAINTENANCE' | 'EVENT';
  pinned: boolean;
  createdAt: string;
  author: { name: string } | string;
}

export interface CreatePassInput {
  flatId: string;
  visitor: {
    name: string;
    phone?: string;
  };
  category: VisitorCategory;
  validFrom: string;
  validUntil: string;
  maxUses?: number;
  accessPointIds: string[];
}

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
  rawName?: string;
  phone?: string | null;
  relation: RelativeRelationType | string;
  defaultVehicle?: string | null;
  notes?: string | null;
  createdAt: string;
  lastVisitAt?: string | null;
  activePassCount: number;
  activePassId?: string;
}

export interface RegisterRelativeRequest {
  flatId?: string;
  name: string;
  phone?: string;
  relation: RelativeRelationType | string;
  defaultVehicle?: string;
  notes?: string;
}

export interface QuickPassRequest {
  validHours?: number;
  maxUses?: number;
  vehicle?: string;
}

export interface QuickPassResult {
  pass: PassView;
  credentials: {
    pin: string;
    qrToken: string;
  };
}

export interface PublicSociety {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

export interface PublicFlat {
  id: string;
  buildingId: string;
  buildingName: string;
  flatNumber: string;
  label: string;
}

export interface RegisterUserRequest {
  name: string;
  email: string;
  password: string;
  phone?: string;
  societyId: string;
  flatId?: string;
  relationship?: 'OWNER' | 'TENANT' | 'FAMILY';
}

export interface RegisterUserResponse {
  user: User;
  expiresIn: number;
  society: {
    id: string;
    name: string;
  };
  flat?: {
    id: string;
    flatNumber: string;
    buildingName: string;
    relationship: 'OWNER' | 'TENANT' | 'FAMILY';
  };
}

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
  accessPoints: AccessPoint[];
  message: string;
  requiresHostApproval: boolean;
}

export interface RazorpayOrderResponse {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
  invoiceId: string;
  flatNumber?: string;
  title?: string;
}

export interface StripeIntentResponse {
  clientSecret: string;
  paymentIntentId: string;
  publishableKey: string;
  amount: number;
  currency: string;
  invoiceId: string;
}

export interface PushTokenRecord {
  id: string;
  platform: string;
  deviceName?: string | null;
  createdAt: string;
  updatedAt: string;
}

