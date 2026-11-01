import { DEFAULT_VISITOR_POLICY, mergeVisitorPolicy, visitorPolicy } from '../src/societies/policy';

describe('visitorPolicy', () => {
  it('returns safe defaults for malformed settings', () => {
    expect(visitorPolicy(null)).toEqual(DEFAULT_VISITOR_POLICY);
    expect(visitorPolicy('not-an-object')).toEqual(DEFAULT_VISITOR_POLICY);
    expect(visitorPolicy([])).toEqual(DEFAULT_VISITOR_POLICY);
  });

  it('keeps known approval categories only', () => {
    const policy = visitorPolicy({
      approvalCategories: ['DELIVERY', 'NOT_REAL', 42, 'CAB'],
    });
    expect(policy.approvalCategories).toEqual(['DELIVERY', 'CAB']);
  });

  it('clamps numeric policy values into their supported ranges', () => {
    const policy = visitorPolicy({
      maxPassDurationHours: 100_000,
      maxUsesPerPass: 0,
      maxPassesPerFlatPerDay: 3.5,
    });
    expect(policy.maxPassDurationHours).toBe(24 * 30);
    expect(policy.maxUsesPerPass).toBe(1);
    expect(policy.maxPassesPerFlatPerDay).toBe(DEFAULT_VISITOR_POLICY.maxPassesPerFlatPerDay);
  });

  it('preserves omitted fields during a partial policy update', () => {
    const settings = {
      approvalCategories: ['DELIVERY'],
      maxPassDurationHours: 24,
      maxUsesPerPass: 5,
      maxPassesPerFlatPerDay: 12,
    };
    const updated = mergeVisitorPolicy(settings, {
      approvalCategories: undefined,
      maxPassDurationHours: undefined,
      maxUsesPerPass: 8,
      maxPassesPerFlatPerDay: undefined,
    });
    expect(updated).toEqual({
      approvalCategories: ['DELIVERY'],
      maxPassDurationHours: 24,
      maxUsesPerPass: 8,
      maxPassesPerFlatPerDay: 12,
    });
  });

  it('does not share the approval array between calls', () => {
    const first = visitorPolicy(undefined);
    first.approvalCategories.push('EXTRA_UNKNOWN' as any);
    expect(visitorPolicy(undefined).approvalCategories).not.toContain('EXTRA_UNKNOWN');
  });
});
