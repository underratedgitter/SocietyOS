import {
  ackSigningString,
  commandSigningString,
  signAck,
  signCommand,
  verifyAck,
  verifyCommand,
} from '../src/common/crypto.util';

const command = {
  commandId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
  accessPointId: '33333333-3333-4333-8333-333333333333',
  type: 'OPEN' as const,
  nonce: 'a'.repeat(32),
  issuedAt: '2026-10-30T10:00:00.000Z',
  expiresAt: '2026-10-30T10:00:30.000Z',
};
const secret = 'test-command-secret';

describe('gate command signatures', () => {
  it('binds every security-relevant field into the canonical string', () => {
    const value = commandSigningString(command);
    expect(value).toContain('societyos-command-v1');
    expect(value).toContain(command.commandId);
    expect(value).toContain(command.nonce);
    expect(value).toContain(command.expiresAt);
  });

  it('verifies a signature produced by the API signer', () => {
    const signature = signCommand(command, secret);
    expect(verifyCommand(command, secret, signature)).toBe(true);
    expect(verifyCommand(command, 'other-secret', signature)).toBe(false);
  });

  it('rejects a command whose payload was changed', () => {
    const signature = signCommand(command, secret);
    expect(verifyCommand({ ...command, accessPointId: '44444444-4444-4444-8444-444444444444' }, secret, signature)).toBe(
      false,
    );
  });
});

describe('device acknowledgement signatures', () => {
  const ack = {
    commandId: command.commandId,
    status: 'EXECUTED' as const,
    nonce: command.nonce,
    gateState: 'OPEN',
    signedAt: '2026-10-30T10:00:01.000Z',
  };

  it('signs and verifies the execution state', () => {
    const signature = signAck(ack, secret);
    expect(verifyAck(ack, secret, signature)).toBe(true);
    expect(verifyAck({ ...ack, gateState: 'CLOSED' }, secret, signature)).toBe(false);
  });

  it('treats a missing gate state distinctly from an empty one', () => {
    const withoutState = { ...ack, gateState: undefined };
    expect(ackSigningString(withoutState)).toBe(
      ['societyos-ack-v1', ack.commandId, ack.status, ack.nonce, '', ack.signedAt].join('\n'),
    );
  });
});
