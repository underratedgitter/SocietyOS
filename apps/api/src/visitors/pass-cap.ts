import { Prisma } from '@prisma/client';

/** Daily cap on anonymous public self-registrations per flat, separate from the host's invite cap. */
export const SELF_REGISTER_MAX_PER_FLAT_PER_DAY = 10;

/**
 * Self-registered passes stay PENDING_APPROVAL (or get REVOKED on rejection) without credentials;
 * credentials are only minted on approval. Until then they must not eat the host's invite quota.
 */
export const COUNTS_TOWARD_HOST_CAP: Prisma.VisitorPassWhereInput = {
  NOT: { status: { in: ['PENDING_APPROVAL', 'REVOKED'] }, credentials: { none: {} } },
};

/** Passes that never got credentials: the anonymous self-registration backlog for a flat. */
export const SELF_REGISTERED_UNAPPROVED: Prisma.VisitorPassWhereInput = {
  status: { in: ['PENDING_APPROVAL', 'REVOKED'] },
  credentials: { none: {} },
};

/** Per-flat transaction-scoped lock serializing count-then-create against the daily caps. */
export async function lockFlatPassCreation(tx: Prisma.TransactionClient, flatId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('visitor-pass-create'), hashtext(${flatId}))`;
}
