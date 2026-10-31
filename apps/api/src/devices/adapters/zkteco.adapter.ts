import { GateController, GateState, GateTelemetry } from './gate-controller.interface';

export interface ZKTecoMatchResult {
  matched: boolean;
  residentId?: string;
  fingerScore: number;
  qualityPassed: boolean;
  algorithm: 'ZKFINGER_V10';
}

export class ZKTecoAdapter implements GateController {
  public readonly type = 'ZKTECO_ZKFINGER';
  private state: GateState = 'CLOSED';
  private emergency = false;
  private sensorDirty = false;
  private deviceFault = false;
  private cycles = 0;
  private lastChange = new Date();
  private templates = new Map<string, string>(); // residentId -> minutiaeHash

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly serialNumber: string = 'ZK9500-REV3',
  ) {}

  enrollFingerprint(residentId: string, minutiaeHash: string): void {
    this.templates.set(residentId, minutiaeHash);
  }

  removeFingerprint(residentId: string): void {
    this.templates.delete(residentId);
  }

  async verifyFingerprint(
    sampleHash: string,
    options: { simulateDirtySensor?: boolean } = {},
  ): Promise<ZKTecoMatchResult> {
    if (this.deviceFault) throw new Error('ZKTeco device FAULT');
    if (options.simulateDirtySensor || this.sensorDirty) {
      return {
        matched: false,
        fingerScore: 18,
        qualityPassed: false,
        algorithm: 'ZKFINGER_V10',
      };
    }

    for (const [resId, hash] of this.templates.entries()) {
      if (hash === sampleHash) {
        return {
          matched: true,
          residentId: resId,
          fingerScore: 88,
          qualityPassed: true,
          algorithm: 'ZKFINGER_V10',
        };
      }
    }

    return {
      matched: false,
      fingerScore: 24,
      qualityPassed: true,
      algorithm: 'ZKFINGER_V10',
    };
  }

  async open(): Promise<void> {
    if (this.deviceFault) throw new Error('ZKTeco controller in FAULT');
    this.transition('OPENING');
    this.cycles += 1;
    this.transition('OPEN');
  }

  async close(): Promise<void> {
    if (this.emergency) throw new Error('Emergency active: ZKTeco relay open');
    this.transition('CLOSING');
    this.transition('CLOSED');
  }

  async stop(): Promise<void> {
    this.transition('STOPPED');
  }

  async emergencyOverride(reason: string): Promise<void> {
    this.emergency = true;
    this.transition('OPEN');
  }

  clearEmergency(): void {
    this.emergency = false;
  }

  setSensorDirty(dirty: boolean): void {
    this.sensorDirty = dirty;
  }

  async getState(): Promise<GateState> {
    return this.state;
  }

  async getHealth(): Promise<boolean> {
    return !this.deviceFault;
  }

  async getTelemetry(): Promise<GateTelemetry> {
    return {
      state: this.state,
      obstructionDetected: this.sensorDirty,
      emergencyActive: this.emergency,
      cyclesCount: this.cycles,
      lastStateChange: this.lastChange,
      metadata: {
        vendor: 'ZKTeco Inc.',
        serialNumber: this.serialNumber,
        sdk: 'ZKFinger SDK v10.0',
        enrolledCount: this.templates.size,
        sensorDirty: this.sensorDirty,
      },
    };
  }

  simulateFault(fault: boolean): void {
    this.deviceFault = fault;
    this.transition(fault ? 'FAULT' : 'CLOSED');
  }

  private transition(next: GateState): void {
    this.state = next;
    this.lastChange = new Date();
  }
}
