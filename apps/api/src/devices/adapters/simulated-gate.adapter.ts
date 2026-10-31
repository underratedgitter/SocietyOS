import { GateController, GateState, GateTelemetry } from './gate-controller.interface';

export class SimulatedGateAdapter implements GateController {
  private state: GateState = 'CLOSED';
  private obstruction = false;
  private fault = false;
  private emergency = false;
  private cycles = 0;
  private lastChange = new Date();

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly motionDurationMs = 50,
  ) {}

  public readonly type = 'SIMULATED';

  async open(): Promise<void> {
    if (this.fault) throw new Error('Cannot open: Gate in FAULT state');
    if (this.obstruction) throw new Error('Cannot open: Safety obstruction active');

    this.transition('OPENING');
    if (this.motionDurationMs > 0) {
      await new Promise((res) => setTimeout(res, this.motionDurationMs));
    }
    this.cycles += 1;
    this.transition('OPEN');
  }

  async close(): Promise<void> {
    if (this.fault) throw new Error('Cannot close: Gate in FAULT state');
    if (this.emergency) throw new Error('Cannot close: Emergency override active');
    if (this.obstruction) {
      this.transition('STOPPED');
      throw new Error('Obstruction detected during close; gate stopped for safety');
    }

    this.transition('CLOSING');
    if (this.motionDurationMs > 0) {
      await new Promise((res) => setTimeout(res, this.motionDurationMs));
    }
    this.transition('CLOSED');
  }

  async stop(): Promise<void> {
    this.transition('STOPPED');
  }

  async emergencyOverride(reason: string): Promise<void> {
    this.emergency = true;
    this.obstruction = false;
    this.transition('OPEN');
  }

  clearEmergency(): void {
    this.emergency = false;
  }

  async getState(): Promise<GateState> {
    return this.state;
  }

  async getHealth(): Promise<boolean> {
    return !this.fault;
  }

  async getTelemetry(): Promise<GateTelemetry> {
    return {
      state: this.state,
      obstructionDetected: this.obstruction,
      emergencyActive: this.emergency,
      cyclesCount: this.cycles,
      lastStateChange: this.lastChange,
    };
  }

  simulateObstruction(obstructed: boolean): void {
    this.obstruction = obstructed;
    if (obstructed && (this.state === 'CLOSING' || this.state === 'OPENING')) {
      this.state = 'STOPPED';
      this.lastChange = new Date();
    }
  }

  simulateFault(fault: boolean): void {
    this.fault = fault;
    if (fault) {
      this.state = 'FAULT';
      this.lastChange = new Date();
    } else if (this.state === 'FAULT') {
      this.state = 'CLOSED';
      this.lastChange = new Date();
    }
  }

  private transition(next: GateState): void {
    this.state = next;
    this.lastChange = new Date();
  }
}
