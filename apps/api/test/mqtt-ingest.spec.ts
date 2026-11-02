import { MqttService } from '../src/devices/mqtt.service';
import { PrismaService } from '../src/common/prisma.service';

type Ingest = { handleMessage(topic: string, payload: Buffer): Promise<void> };

describe('MqttService device telemetry ingestion', () => {
  const SOCIETY = '11111111-1111-4111-8111-111111111111';
  const DEVICE = '55555555-5555-4555-8555-555555555555';

  function build(status: 'ACTIVE' | 'DISABLED' | 'REVOKED') {
    const prisma = {
      device: {
        findFirst: jest.fn().mockResolvedValue({ id: DEVICE, societyId: SOCIETY, status }),
        update: jest.fn().mockReturnValue({ kind: 'device.update' }),
      },
      deviceEvent: { create: jest.fn().mockResolvedValue({ id: 'evt-1' }) },
      deviceHealthLog: { create: jest.fn().mockReturnValue({ kind: 'health.create' }) },
      deviceAccessPoint: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    const service = new MqttService(prisma as unknown as PrismaService) as unknown as Ingest;
    return { prisma, service };
  }

  const json = (body: Record<string, unknown>): Buffer => Buffer.from(JSON.stringify(body));

  it.each(['DISABLED', 'REVOKED'] as const)('drops events and health from a %s device', async (status) => {
    const { prisma, service } = build(status);

    await service.handleMessage(`society/${SOCIETY}/device/${DEVICE}/events`, json({ type: 'TAMPER', sequence: 7 }));
    await service.handleMessage(`society/${SOCIETY}/device/${DEVICE}/health`, json({ online: true, uptimeS: 5 }));

    expect(prisma.deviceEvent.create).not.toHaveBeenCalled();
    expect(prisma.deviceHealthLog.create).not.toHaveBeenCalled();
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('records events and health from an ACTIVE device', async () => {
    const { prisma, service } = build('ACTIVE');

    await service.handleMessage(`society/${SOCIETY}/device/${DEVICE}/events`, json({ type: 'TAMPER', sequence: 7 }));
    await service.handleMessage(`society/${SOCIETY}/device/${DEVICE}/health`, json({ online: true, uptimeS: 5 }));

    expect(prisma.deviceEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deviceId: DEVICE, type: 'TAMPER', sequence: 7 }) }),
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
