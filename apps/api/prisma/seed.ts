import 'dotenv/config';
import { Flat, PrismaClient, User, VisitorCategory } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'crypto';
import { getEnv } from '../src/config';

const prisma = new PrismaClient();
const env = getEnv();
const DEMO_PASSWORD = 'Society#2026';

function credentialHash(value: string): string {
  return createHmac('sha256', `${env.credentialHmacKeyId}:${env.credentialHmacKey}`)
    .update(value)
    .digest('hex');
}

function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', env.deviceSecretKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

async function upsertUser(input: {
  name: string;
  email: string;
  phone?: string;
  password?: string;
  isPlatformAdmin?: boolean;
}) {
  const passwordHash = await bcrypt.hash(input.password ?? DEMO_PASSWORD, 12);
  return prisma.user.upsert({
    where: { email: input.email },
    create: {
      name: input.name,
      email: input.email,
      phone: input.phone,
      passwordHash,
      isPlatformAdmin: input.isPlatformAdmin ?? false,
      mustChangePassword: false,
    },
    update: {
      name: input.name,
      phone: input.phone,
      passwordHash,
      isPlatformAdmin: input.isPlatformAdmin ?? false,
      mustChangePassword: false,
    },
  });
}

async function upsertMembership(societyId: string, userId: string, role: 'SOCIETY_ADMIN' | 'RESIDENT' | 'GUARD') {
  return prisma.societyMembership.upsert({
    where: { societyId_userId: { societyId, userId } },
    create: { societyId, userId, role, status: 'ACTIVE' },
    update: { role, status: 'ACTIVE' },
  });
}

async function ensureBuilding(societyId: string, name: string) {
  const existing = await prisma.building.findFirst({ where: { societyId, name } });
  return existing ?? prisma.building.create({ data: { societyId, name } });
}

async function ensureFlat(buildingId: string, flatNumber: string) {
  return prisma.flat.upsert({
    where: { buildingId_flatNumber: { buildingId, flatNumber } },
    create: { buildingId, flatNumber },
    update: {},
  });
}

async function ensureAccessPoint(societyId: string, name: string, type: 'BOOM_BARRIER' | 'SLIDING_GATE' | 'DOOR_LOCK') {
  const existing = await prisma.accessPoint.findFirst({ where: { societyId, name, type } });
  return existing ?? prisma.accessPoint.create({ data: { societyId, name, type, location: name } });
}

async function ensureDevice(input: {
  societyId: string;
  deviceUid: string;
  name: string;
  accessPointIds: string[];
  token: string;
  commandSecret: string;
  firmware: string;
}) {
  const device = await prisma.device.upsert({
    where: { deviceUid: input.deviceUid },
    create: {
      societyId: input.societyId,
      deviceUid: input.deviceUid,
      name: input.name,
      firmware: input.firmware,
      status: 'ACTIVE',
    },
    update: {
      societyId: input.societyId,
      name: input.name,
      firmware: input.firmware,
      status: 'ACTIVE',
    },
  });
  await prisma.deviceAccessPoint.deleteMany({ where: { deviceId: device.id } });
  await prisma.deviceAccessPoint.createMany({
    data: input.accessPointIds.map((accessPointId) => ({ deviceId: device.id, accessPointId })),
  });
  await prisma.deviceCredential.deleteMany({ where: { deviceId: device.id } });
  await prisma.deviceCredential.create({
    data: {
      deviceId: device.id,
      tokenHash: createHash('sha256').update(input.token).digest('hex'),
      commandSecretEnc: encryptSecret(input.commandSecret),
      keyId: 'v1',
    },
  });
  await prisma.deviceHealthLog.create({
    data: { deviceId: device.id, online: true, uptimeS: 3600, rssi: -61, meta: { seeded: true } },
  });
  return device;
}

async function ensurePass(input: {
  societyId: string;
  flatId: string;
  hostUserId: string;
  visitorName: string;
  phone?: string;
  category: VisitorCategory;
  status: 'ACTIVE' | 'PENDING_APPROVAL' | 'REVOKED' | 'EXPIRED' | 'EXHAUSTED';
  validFrom: Date;
  validUntil: Date;
  maxUses: number;
  usedCount: number;
  pin: string;
  qrToken: string;
  accessPointIds: string[];
  revoked?: boolean;
}) {
  const existing = await prisma.visitorPass.findFirst({
    where: {
      societyId: input.societyId,
      flatId: input.flatId,
      category: input.category,
      visitor: { name: input.visitorName },
    },
  });
  const credentials = [
    {
      type: 'PIN' as const,
      credentialHash: credentialHash(input.pin),
      keyId: env.credentialHmacKeyId,
    },
    {
      type: 'QR' as const,
      credentialHash: credentialHash(input.qrToken),
      keyId: env.credentialHmacKeyId,
    },
  ];

  if (existing) {
    // Demo fixtures are reset on every seed so rehearsals start from the documented state.
    await prisma.visitor.update({
      where: { id: existing.visitorId },
      data: { name: input.visitorName, phone: input.phone, category: input.category },
    });
    await prisma.$transaction(async (tx) => {
      await tx.visitorPassCredential.deleteMany({ where: { passId: existing.id } });
      await tx.visitorPassAccessPoint.deleteMany({ where: { passId: existing.id } });
      await tx.visitorPassUse.deleteMany({ where: { passId: existing.id } });
      await tx.visitorApproval.deleteMany({ where: { passId: existing.id } });
      await tx.visitorPass.update({
        where: { id: existing.id },
        data: {
          status: input.status,
          validFrom: input.validFrom,
          validUntil: input.validUntil,
          maxUses: input.maxUses,
          usedCount: input.usedCount,
          revokedAt: input.revoked ? new Date() : null,
          revokedBy: input.revoked ? input.hostUserId : null,
        },
      });
      await tx.visitorPassCredential.createMany({
        data: credentials.map((credential) => ({ ...credential, passId: existing.id })),
      });
      await tx.visitorPassAccessPoint.createMany({
        data: input.accessPointIds.map((accessPointId) => ({ passId: existing.id, accessPointId })),
      });
    });
    return existing;
  }

  const visitor = await prisma.visitor.create({
    data: {
      societyId: input.societyId,
      name: input.visitorName,
      phone: input.phone,
      category: input.category,
    },
  });
  const pass = await prisma.visitorPass.create({
    data: {
      societyId: input.societyId,
      flatId: input.flatId,
      hostUserId: input.hostUserId,
      visitorId: visitor.id,
      category: input.category,
      status: input.status,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      maxUses: input.maxUses,
      usedCount: input.usedCount,
      ...(input.revoked ? { revokedAt: new Date(), revokedBy: input.hostUserId } : {}),
      credentials: { create: credentials },
      accessPoints: { create: input.accessPointIds.map((accessPointId) => ({ accessPointId })) },
    },
  });
  return pass;
}

async function main() {
  const platform = await upsertUser({
    name: 'Platform Operator',
    email: 'platform@societyos.dev',
    password: 'Platform#2026',
    isPlatformAdmin: true,
  });

  const societyA = await prisma.society.upsert({
    where: { slug: 'palm-grove' },
    create: {
      name: 'Palm Grove Residency',
      slug: 'palm-grove',
      timezone: 'Asia/Kolkata',
      settings: {
        approvalCategories: ['DELIVERY', 'CAB'],
        maxPassDurationHours: 24,
        maxUsesPerPass: 5,
        maxPassesPerFlatPerDay: 20,
      },
    },
    update: {
      name: 'Palm Grove Residency',
      timezone: 'Asia/Kolkata',
      settings: {
        approvalCategories: ['DELIVERY', 'CAB'],
        maxPassDurationHours: 24,
        maxUsesPerPass: 5,
        maxPassesPerFlatPerDay: 20,
      },
    },
  });
  const societyB = await prisma.society.upsert({
    where: { slug: 'harbour-heights' },
    create: { name: 'Harbour Heights', slug: 'harbour-heights', timezone: 'Asia/Kolkata' },
    update: { name: 'Harbour Heights', timezone: 'Asia/Kolkata' },
  });

  const adminA = await upsertUser({ name: 'Ananya Rao', email: 'admin.a@societyos.dev', password: 'AdminA#2026' });
  const adminB = await upsertUser({ name: 'Vikram Shah', email: 'admin.b@societyos.dev', password: 'AdminB#2026' });
  const guardA = await upsertUser({ name: 'Ramesh Kumar', email: 'guard.a@societyos.dev', password: 'GuardA#2026' });
  const guardB = await upsertUser({ name: 'Suresh Patil', email: 'guard.b@societyos.dev', password: 'GuardB#2026' });
  await upsertMembership(societyA.id, adminA.id, 'SOCIETY_ADMIN');
  await upsertMembership(societyB.id, adminB.id, 'SOCIETY_ADMIN');
  await upsertMembership(societyA.id, guardA.id, 'GUARD');
  await upsertMembership(societyB.id, guardB.id, 'GUARD');

  const towerA = await ensureBuilding(societyA.id, 'Tower A');
  const towerB = await ensureBuilding(societyA.id, 'Tower B');
  const marine = await ensureBuilding(societyB.id, 'Marine Block');

  const flatsA: Flat[] = [];
  for (let floor = 1; floor <= 5; floor += 1) {
    for (const unit of ['01', '02']) {
      flatsA.push(await ensureFlat(towerA.id, `${floor}${unit}`));
    }
  }
  for (let index = 1; index <= 5; index += 1) {
    flatsA.push(await ensureFlat(towerB.id, `B-10${index}`));
  }
  const flatsB: Flat[] = [];
  for (let index = 1; index <= 10; index += 1) {
    flatsB.push(await ensureFlat(marine.id, `M-${String(index).padStart(3, '0')}`));
  }

  const residentsA: { user: User; flat: Flat }[] = [];
  const residentsB: { user: User; flat: Flat }[] = [];
  for (let index = 0; index < 10; index += 1) {
    const resident = await upsertUser({
      name: ['Meera Iyer', 'Arjun Nair', 'Kavya Menon', 'Rohan Gupta', 'Sara Khan', 'Dev Patel', 'Nisha Verma', 'Aditya Bose', 'Tara Reddy', 'Kabir Singh'][index],
      email: `resident.a${index + 1}@societyos.dev`,
      phone: `+9198000000${String(index + 1).padStart(2, '0')}`,
    });
    await upsertMembership(societyA.id, resident.id, 'RESIDENT');
    await prisma.residentFlatMembership.upsert({
      where: { flatId_userId: { flatId: flatsA[index].id, userId: resident.id } },
      create: { flatId: flatsA[index].id, userId: resident.id, relationship: 'OWNER' },
      update: { endedAt: null, relationship: 'OWNER' },
    });
    residentsA.push({ user: resident, flat: flatsA[index] });
  }
  for (let index = 0; index < 10; index += 1) {
    const resident = await upsertUser({
      name: ['Ishaan Joshi', 'Priya Desai', 'Neel Kulkarni', 'Riya Shetty', 'Omkar Pawar', 'Jaya Naik', 'Farhan Ali', 'Maya Fernandes', 'Yash Dalvi', 'Zoya Mirza'][index],
      email: `resident.b${index + 1}@societyos.dev`,
      phone: `+9197000000${String(index + 1).padStart(2, '0')}`,
    });
    await upsertMembership(societyB.id, resident.id, 'RESIDENT');
    await prisma.residentFlatMembership.upsert({
      where: { flatId_userId: { flatId: flatsB[index].id, userId: resident.id } },
      create: { flatId: flatsB[index].id, userId: resident.id, relationship: 'OWNER' },
      update: { endedAt: null, relationship: 'OWNER' },
    });
    residentsB.push({ user: resident, flat: flatsB[index] });
  }

  const mainGateA = await ensureAccessPoint(societyA.id, 'Main Vehicle Gate', 'BOOM_BARRIER');
  const pedestrianA = await ensureAccessPoint(societyA.id, 'Pedestrian Gate', 'SLIDING_GATE');
  const clubDoorA = await ensureAccessPoint(societyA.id, 'Clubhouse Door', 'DOOR_LOCK');
  const mainGateB = await ensureAccessPoint(societyB.id, 'Harbour Main Gate', 'BOOM_BARRIER');

  const simulatorToken = process.env.SEED_SIMULATOR_TOKEN || 'sos_dev_demo_simulator_token_a_change_me_2026';
  const simulatorSecret = process.env.SEED_SIMULATOR_COMMAND_SECRET || 'demo-command-secret-a-change-me-2026';

  await ensureDevice({
    societyId: societyA.id,
    deviceUid: 'sim-a-main',
    name: 'Virtual Barrier Controller A',
    accessPointIds: [mainGateA.id, pedestrianA.id],
    token: simulatorToken,
    commandSecret: simulatorSecret,
    firmware: 'sim-1.0.0',
  });
  await ensureDevice({
    societyId: societyB.id,
    deviceUid: 'sim-b-main',
    name: 'Virtual Barrier Controller B',
    accessPointIds: [mainGateB.id],
    token: `sos_dev_${randomBytes(24).toString('hex')}`,
    commandSecret: `secret-${randomUUID()}`,
    firmware: 'sim-1.0.0',
  });

  const now = new Date();
  await ensurePass({
    societyId: societyA.id,
    flatId: residentsA[0].flat.id,
    hostUserId: residentsA[0].user.id,
    visitorName: 'Rahul Sharma',
    phone: '+919876543210',
    category: 'RELATIVE',
    status: 'ACTIVE',
    validFrom: new Date(now.getTime() - 60 * 60 * 1000),
    validUntil: new Date(now.getTime() + 5 * 60 * 60 * 1000),
    maxUses: 2,
    usedCount: 0,
    pin: '123456',
    qrToken: 'demo-qr-token-a1',
    accessPointIds: [mainGateA.id, pedestrianA.id],
  });
  await ensurePass({
    societyId: societyA.id,
    flatId: residentsA[1].flat.id,
    hostUserId: residentsA[1].user.id,
    visitorName: 'Amazon Delivery',
    phone: '+919876500001',
    category: 'DELIVERY',
    status: 'PENDING_APPROVAL',
    validFrom: new Date(now.getTime() - 10 * 60 * 1000),
    validUntil: new Date(now.getTime() + 2 * 60 * 60 * 1000),
    maxUses: 1,
    usedCount: 0,
    pin: '222222',
    qrToken: 'demo-qr-token-pending',
    accessPointIds: [mainGateA.id],
  });
  await ensurePass({
    societyId: societyA.id,
    flatId: residentsA[2].flat.id,
    hostUserId: residentsA[2].user.id,
    visitorName: 'Past Friend',
    category: 'FRIEND',
    status: 'ACTIVE',
    validFrom: new Date(now.getTime() - 8 * 3600 * 1000),
    validUntil: new Date(now.getTime() - 60 * 60 * 1000),
    maxUses: 1,
    usedCount: 0,
    pin: '333333',
    qrToken: 'demo-qr-token-expired',
    accessPointIds: [mainGateA.id],
  });
  await ensurePass({
    societyId: societyA.id,
    flatId: residentsA[3].flat.id,
    hostUserId: residentsA[3].user.id,
    visitorName: 'Revoked Guest',
    category: 'OTHER',
    status: 'REVOKED',
    validFrom: new Date(now.getTime() - 3600 * 1000),
    validUntil: new Date(now.getTime() + 3600 * 1000),
    maxUses: 1,
    usedCount: 0,
    pin: '444444',
    qrToken: 'demo-qr-token-revoked',
    accessPointIds: [mainGateA.id],
    revoked: true,
  });
  await ensurePass({
    societyId: societyA.id,
    flatId: residentsA[4].flat.id,
    hostUserId: residentsA[4].user.id,
    visitorName: 'Used Guest',
    category: 'OTHER',
    status: 'EXHAUSTED',
    validFrom: new Date(now.getTime() - 3600 * 1000),
    validUntil: new Date(now.getTime() + 3600 * 1000),
    maxUses: 1,
    usedCount: 1,
    pin: '555555',
    qrToken: 'demo-qr-token-used',
    accessPointIds: [mainGateA.id],
  });
  await ensurePass({
    societyId: societyB.id,
    flatId: residentsB[0].flat.id,
    hostUserId: residentsB[0].user.id,
    visitorName: 'Harbour Guest',
    category: 'RELATIVE',
    status: 'ACTIVE',
    validFrom: new Date(now.getTime() - 60 * 60 * 1000),
    validUntil: new Date(now.getTime() + 4 * 60 * 60 * 1000),
    maxUses: 1,
    usedCount: 0,
    pin: '654321',
    qrToken: 'demo-qr-token-b1',
    accessPointIds: [mainGateB.id],
  });

  await prisma.auditLog.create({
    data: {
      societyId: societyA.id,
      actorUserId: platform.id,
      actorRole: 'PLATFORM_ADMIN',
      action: 'DEMO_SEEDED',
      entityType: 'Society',
      entityId: societyA.id,
      meta: { seededAt: new Date().toISOString() },
    },
  }).catch(() => undefined);

  console.log('\nSocietyOS demo data is ready.');
  console.table([
    { role: 'Platform admin', email: 'platform@societyos.dev', password: 'Platform#2026' },
    { role: 'Palm Grove admin', email: 'admin.a@societyos.dev', password: 'AdminA#2026' },
    { role: 'Harbour admin', email: 'admin.b@societyos.dev', password: 'AdminB#2026' },
    { role: 'Palm Grove guard', email: 'guard.a@societyos.dev', password: 'GuardA#2026' },
    { role: 'Palm Grove resident', email: 'resident.a1@societyos.dev', password: DEMO_PASSWORD },
    { role: 'Harbour resident', email: 'resident.b1@societyos.dev', password: DEMO_PASSWORD },
  ]);
  console.log('Demo visitor PINs: 123456 (active), 222222 (pending), 654321 (Harbour).');
  console.log('Simulator device: sim-a-main');
  console.log(`SIMULATOR DEVICE_TOKEN=${simulatorToken}`);
  console.log(`SIMULATOR COMMAND_SECRET=${simulatorSecret}`);
  console.log('These credentials are for local demonstration only.\n');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
