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

export interface SocietySummary {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  role: Role;
  createdAt: string;
  policy?: VisitorPolicy;
  _count?: { buildings: number; accessPoints: number; devices: number };
}

export interface VisitorPolicy {
  approvalCategories: VisitorCategory[];
  maxPassDurationHours: number;
  maxUsesPerPass: number;
  maxPassesPerFlatPerDay: number;
}

export interface Membership {
  society: { id: string; name: string; slug: string; timezone: string };
  role: Role;
  status: 'ACTIVE' | 'INVITED' | 'DISABLED';
}

export interface FlatLink {
  id: string;
  flatNumber: string;
  building: { id: string; name: string; societyId: string };
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
  devices?: Device[];
}

export interface Device {
  id: string;
  deviceUid: string;
  name: string;
  societyId: string;
  status: 'ACTIVE' | 'DISABLED' | 'REVOKED';
  firmware: string | null;
  lastSeenAt: string | null;
  accessPoints: { id: string; name: string; type: string }[];
  latestHealth?: { online: boolean; recordedAt: string; rssi: number | null } | null;
}

export interface PassView {
  id: string;
  societyId: string;
  status: PassStatus;
  effectiveStatus: PassStatus;
  category: VisitorCategory;
  visitor: { id: string; name: string; phone: string | null };
  flat: { id: string; flatNumber: string; building: string };
  host: { id: string; name: string };
  validFrom: string;
  validUntil: string;
  maxUses: number;
  usedCount: number;
  accessPoints: { id: string; name: string; type: string }[];
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
  credentials: { pin: string; qrToken: string };
}

export interface HouseholdMember {
  userId: string;
  name: string;
  relationship: 'OWNER' | 'TENANT' | 'FAMILY';
  joinedAt: string;
  isSelf: boolean;
}

export interface VerifyResponse {
  decision: 'AUTHORIZED' | 'DENIED';
  reasonCode: string;
  accessEventId: string;
  commandId?: string;
  expiresAt?: string;
}

export interface Building {
  id: string;
  name: string;
  flats: { id: string; flatNumber: string; residentCount: number }[];
}

export interface Resident {
  userId: string;
  name: string;
  email?: string;
  phone?: string | null;
  status: 'ACTIVE' | 'INVITED' | 'DISABLED';
  flats: { id: string; flatNumber: string; building: string; relationship: string }[];
}

export interface StaffMember {
  userId: string;
  name: string;
  email?: string;
  phone?: string | null;
  role: 'SOCIETY_ADMIN' | 'GUARD';
  status: 'ACTIVE' | 'INVITED' | 'DISABLED';
  createdAt: string;
}

export interface FlatOption {
  id: string;
  label: string;
  building: string;
  flatNumber: string;
}

export interface AccessEvent {
  id: string;
  societyId: string;
  accessPointId: string | null;
  deviceId: string | null;
  passId: string | null;
  decision: 'AUTHORIZED' | 'DENIED';
  reasonCode: string;
  credentialType: 'PIN' | 'QR' | null;
  source: string;
  requestedAt: string;
  accessPoint?: { id: string; name: string } | null;
  pass?: {
    id: string;
    visitor: { name: string };
    flat: { flatNumber: string };
  } | null;
}

export interface GateCommand {
  id: string;
  type: 'OPEN' | 'CLOSE' | 'STOP';
  status: 'ISSUED' | 'ACKNOWLEDGED' | 'EXECUTED' | 'FAILED' | 'EXPIRED';
  issuedAt: string;
  expiresAt: string;
  ackAt: string | null;
  executedAt: string | null;
  gateStateAtExec: string | null;
  device: { id: string; deviceUid: string; name: string };
  accessPoint: { id: string; name: string };
}

export interface Overview {
  counts: {
    buildings: number;
    flats: number;
    residents: number;
    activePasses: number;
    pendingPasses: number;
    devices: number;
    onlineDevices: number;
    openAlerts: number;
    allowedToday: number;
    deniedToday: number;
  };
  recentEvents: AccessEvent[];
  policy: VisitorPolicy;
  timezone: string;
  role: Role;
}

export interface AuditLog {
  id: string;
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
  meta: Record<string, unknown> | null;
}

export interface SecurityAlert {
  id: string;
  severity: string;
  type: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface DeviceCredentials {
  deviceToken: string;
  commandSecret: string;
  note: string;
}

export type DeviceProtocol =
  | 'NATIVE'
  | 'GENERIC_WEBHOOK'
  | 'ZKTECO_ADMS'
  | 'HIKVISION_ISAPI'
  | 'DAHUA_HTTP'
  | 'SUPREMA_BIOSTAR2'
  | 'MATRIX_COSEC';

export interface BiometricIdentity {
  id: string;
  societyId: string;
  userId: string;
  deviceUserId: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface DeviceProvisionResult {
  device: Device;
  credentials: DeviceCredentials;
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

export interface MaintenanceTicket {
  id: string;
  societyId: string;
  flat: { id: string; flatNumber: string; building: string | { name: string } };
  category: 'PLUMBING' | 'ELECTRICAL' | 'LIFT' | 'COMMON_AREA' | 'CARPENTRY';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
  title: string;
  description: string;
  assignedStaff?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AmenityBooking {
  id: string;
  societyId: string;
  amenityName: string;
  flat: { id: string; flatNumber: string; building: string | { name: string } };
  bookedBy: string | { name: string };
  slotStart: string;
  slotEnd: string;
  guestCount: number;
  status: 'CONFIRMED' | 'CANCELLED';
  createdAt: string;
}

export interface MaintenanceInvoice {
  id: string;
  societyId: string;
  flat: { id: string; flatNumber: string; building: string | { name: string } };
  title: string;
  description?: string | null;
  amount: number;
  dueDate: string;
  status: 'PENDING' | 'PAID' | 'OVERDUE' | 'CANCELLED';
  paidAt?: string | null;
  paidBy?: { id: string; name: string; email: string } | null;
  paymentReference?: string | null;
  createdAt: string;
}

