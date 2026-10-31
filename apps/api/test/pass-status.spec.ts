import { VisitorPassesService } from '../src/visitors/visitor-passes.service';

const service = new VisitorPassesService({} as never, {} as never, {} as never, {} as never);
const future = new Date(Date.now() + 60 * 60 * 1000);
const past = new Date(Date.now() - 60 * 60 * 1000);

describe('VisitorPassesService.effectiveStatus', () => {
  it('makes a stored ACTIVE pass usable inside its window', () => {
    expect(
      service.effectiveStatus({
        status: 'ACTIVE',
        validFrom: past,
        validUntil: future,
        usedCount: 0,
        maxUses: 1,
      }),
    ).toBe('ACTIVE');
  });

  it('reports a future pass as scheduled rather than active', () => {
    expect(
      service.effectiveStatus({
        status: 'ACTIVE',
        validFrom: future,
        validUntil: new Date(Date.now() + 2 * 60 * 60 * 1000),
        usedCount: 0,
        maxUses: 1,
      }),
    ).toBe('SCHEDULED');
  });

  it('reports expiry and exhaustion from the clock and use count', () => {
    expect(
      service.effectiveStatus({
        status: 'ACTIVE',
        validFrom: past,
        validUntil: past,
        usedCount: 0,
        maxUses: 1,
      }),
    ).toBe('EXPIRED');
    expect(
      service.effectiveStatus({
        status: 'ACTIVE',
        validFrom: past,
        validUntil: future,
        usedCount: 1,
        maxUses: 1,
      }),
    ).toBe('EXHAUSTED');
  });

  it('keeps terminal and approval states authoritative', () => {
    const base = { validFrom: past, validUntil: future, usedCount: 0, maxUses: 1 };
    expect(service.effectiveStatus({ ...base, status: 'REVOKED' })).toBe('REVOKED');
    expect(service.effectiveStatus({ ...base, status: 'PENDING_APPROVAL' })).toBe('PENDING_APPROVAL');
    expect(service.effectiveStatus({ ...base, status: 'DRAFT' })).toBe('DRAFT');
  });
});
