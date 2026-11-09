import { MqttService } from '../src/devices/mqtt.service';
import { PrismaService } from '../src/common/prisma.service';
import { encryptDeviceSecret, signAck } from '../src/common/crypto.util';

describe('MQTT command acknowledgement expiry', () => {
  it.each([-1_000, 60_000])('only accepts execution before command expiry (%i ms)', async (remaining) => {
    const secret = 'dummy-command-secret';
    const command = {
      id: 'cmd', deviceId: 'device', nonce: 'nonce', status: 'ISSUED', ackAt: null,
      expiresAt: new Date(Date.now() + remaining),
      device: { societyId: 'society', credentials: [{ commandSecretEnc: encryptDeviceSecret(secret) }] },
    };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = new MqttService({
      gateCommand: { findUnique: jest.fn().mockResolvedValue(command), updateMany },
    } as unknown as PrismaService) as unknown as {
      onAcknowledgement(scope: { societyId: string; deviceId: string }, body: Record<string, unknown>): Promise<void>;
    };
    const ack = { commandId: 'cmd', status: 'EXECUTED' as const, nonce: 'nonce', signedAt: new Date().toISOString(), gateState: 'OPEN' };
    await service.onAcknowledgement({ societyId: 'society', deviceId: 'device' }, { ...ack, signature: signAck(ack, secret) });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: remaining < 0 ? 'EXPIRED' : 'EXECUTED' }),
    }));
    if (remaining > 0) expect(updateMany.mock.calls[0][0].where.expiresAt).toEqual({ gt: expect.any(Date) });
  });
});
