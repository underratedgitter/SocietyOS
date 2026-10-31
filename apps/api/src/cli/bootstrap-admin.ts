/**
 * Creates the first platform administrator for a fresh production database.
 * Runs without Nest so it can be executed from the API image:
 *
 *   node dist/cli/bootstrap-admin.js --email ops@example.com --name "Ops"
 *
 * The account is created with mustChangePassword=true and a one-time password
 * printed to stdout. Existing users are never modified by this command.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    return value;
  }
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

async function main(): Promise<void> {
  const email = (argument('email') || process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
  const name = (argument('name') || process.env.BOOTSTRAP_ADMIN_NAME || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Provide a valid --email (or BOOTSTRAP_ADMIN_EMAIL)');
  }
  if (name.length < 2 || name.length > 120) {
    throw new Error('Provide a --name between 2 and 120 characters (or BOOTSTRAP_ADMIN_NAME)');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new Error(
        'A user with this email already exists. Bootstrap never resets existing accounts; use the normal sign-in flow.',
      );
    }
    const temporaryPassword = randomBytes(12).toString('base64url');
    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: await bcrypt.hash(temporaryPassword, 12),
        isPlatformAdmin: true,
        mustChangePassword: true,
      },
    });
    await prisma.auditLog.create({
      data: {
        actorUserId: user.id,
        actorRole: 'PLATFORM_ADMIN',
        action: 'PLATFORM_ADMIN_BOOTSTRAPPED',
        entityType: 'User',
        entityId: user.id,
        meta: { email, source: 'cli' },
      },
    }).catch(() => undefined);

    console.log('Platform administrator created.');
    console.log(`  email: ${email}`);
    console.log(`  temporary password: ${temporaryPassword}`);
    console.log('The password is shown once and must be changed at first sign-in.');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
