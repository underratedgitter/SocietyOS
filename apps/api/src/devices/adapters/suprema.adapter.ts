import { GateController, GateState, GateTelemetry } from './gate-controller.interface';

export interface SupremaMatchResult {
  matched: boolean;
  residentId?: string;
  confidenceScore: number;
  livenessPassed: boolean;
  algorithm: 'SUPREMA_FACE_V3' | 'SUPREMA_FINGER_V2';
}

export class SupremaAdapter implements GateController {
  public readonly type = 'SUPREMA_BIOSTAR';
  private state: GateState = 'CLOSED';
  private emergency = false;
  private deviceFault = false;
  private cycles = 0;
  private lastChange = new Date();
  private enrolledTemplates = new Map<string, string>(); // residentId -> templateHash

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly deviceModel: 'BioStation_3' | 'BioEntry_W2' = 'BioStation_3',
    public readonly ipAddress: string = '192.168.1.100',
  ) {}

  enrollTemplate(residentId: string, templateHash: string): void {
    this.enrolledTemplates.set(residentId, templateHash);
  }

  removeTemplate(residentId: string): void {
    this.enrolledTemplates.delete(residentId);
  }

  async verifyBiometricOnDevice(
    credentialHash: string,
    options: { simulateSpoof?: boolean } = {},
  ): Promise<SupremaMatchResult> {
    if (this.deviceFault) {
      throw new Error('Suprema terminal unreachable or in FAULT mode');
    }

    if (options.simulateSpoof) {
      return {
        matched: false,
        confidenceScore: 0.12,
        livenessPassed: false,
        algorithm: 'SUPREMA_FACE_V3',
      };
    }

    for (const [resId, hash] of this.enrolledTemplates.entries()) {
      if (hash === credentialHash) {
        return {
          matched: true,
          residentId: resId,
          confidenceScore: 0.98,
          livenessPassed: true,
          algorithm: 'SUPREMA_FACE_V3',
        };
      }
    }

    return {
      matched: false,
      confidenceScore: 0.35,
      livenessPassed: true,
      algorithm: 'SUPREMA_FACE_V3',
    };
  }

  async open(): Promise<void> {
    if (this.deviceFault) throw new Error('Suprema terminal FAULT');
    this.transition('OPENING');
    this.cycles += 1;
    this.transition('OPEN');
  }

  async close(): Promise<void> {
    if (this.emergency) throw new Error('Emergency active: Suprema relay held energized');
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

  async getState(): Promise<GateState> {
    return this.state;
  }

  async getHealth(): Promise<boolean> {
    return !this.deviceFault;
  }

  async getTelemetry(): Promise<GateTelemetry> {
    return {
      state: this.state,
      obstructionDetected: false,
      emergencyActive: this.emergency,
      cyclesCount: this.cycles,
      lastStateChange: this.lastChange,
      metadata: {
        vendor: 'Suprema Inc.',
        model: this.deviceModel,
        ipAddress: this.ipAddress,
        firmware: 'v2.1.0-secure',
        enrolledTemplatesCount: this.enrolledTemplates.size,
        tamperSwitchOk: true,
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
