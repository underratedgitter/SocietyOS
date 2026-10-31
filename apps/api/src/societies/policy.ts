import { VisitorCategory } from '@prisma/client';

export interface VisitorPolicy {
  approvalCategories: VisitorCategory[];
  maxPassDurationHours: number;
  maxUsesPerPass: number;
  maxPassesPerFlatPerDay: number;
}

export const DEFAULT_VISITOR_POLICY: VisitorPolicy = {
  approvalCategories: ['DELIVERY', 'CAB'],
  maxPassDurationHours: 24,
  maxUsesPerPass: 5,
  maxPassesPerFlatPerDay: 20,
};

const ALL_CATEGORIES = new Set<string>([
  'RELATIVE',
  'FRIEND',
  'DELIVERY',
  'CAB',
  'MAINTENANCE',
  'OTHER',
]);

export function visitorPolicy(settings: unknown): VisitorPolicy {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ...DEFAULT_VISITOR_POLICY, approvalCategories: [...DEFAULT_VISITOR_POLICY.approvalCategories] };
  }
  const raw = settings as Record<string, unknown>;
  const approval = Array.isArray(raw.approvalCategories)
    ? raw.approvalCategories
        .filter((value): value is VisitorCategory => typeof value === 'string' && ALL_CATEGORIES.has(value))
    : DEFAULT_VISITOR_POLICY.approvalCategories;

  return {
    approvalCategories: [...new Set(approval)],
    maxPassDurationHours: clampInt(raw.maxPassDurationHours, 1, 24 * 30, DEFAULT_VISITOR_POLICY.maxPassDurationHours),
    maxUsesPerPass: clampInt(raw.maxUsesPerPass, 1, 10, DEFAULT_VISITOR_POLICY.maxUsesPerPass),
    maxPassesPerFlatPerDay: clampInt(
      raw.maxPassesPerFlatPerDay,
      1,
      100,
      DEFAULT_VISITOR_POLICY.maxPassesPerFlatPerDay,
    ),
  };
}

/** Applies only the fields a client actually sent, preserving the rest of the stored policy. */
export function mergeVisitorPolicy(settings: unknown, patch: Partial<VisitorPolicy>): VisitorPolicy {
  const current = visitorPolicy(settings);
  return {
    approvalCategories: patch.approvalCategories ?? current.approvalCategories,
    maxPassDurationHours: patch.maxPassDurationHours ?? current.maxPassDurationHours,
    maxUsesPerPass: patch.maxUsesPerPass ?? current.maxUsesPerPass,
    maxPassesPerFlatPerDay: patch.maxPassesPerFlatPerDay ?? current.maxPassesPerFlatPerDay,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
