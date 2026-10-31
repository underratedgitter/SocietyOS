import { GateController, GateState, GateTelemetry } from './gate-controller.interface';

export class BoomBarrierAdapter implements GateController {
  public readonly type = 'BOOM_BARRIER';
  private state: GateState = 'CLOSED';
  private vehicleDetected = false;
  private antiTailgateTimeout: NodeJS.Timeout | null = null;
  private obstruction = false;
  private emergency = false;
  private fault = false;
  private cycles = 0;
  private lastChange = new Date();

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly motionDurationMs = 40,
    public readonly autoCloseDelayMs = 5000,
  ) {}

  async open(): Promise<void> {
    if (this.fault) throw new Error('Boom barrier in FAULT state');
    if (this.obstruction) throw new Error('Safety loop sensor obstructed');

    this.transition('OPENING');
    if (this.motionDurationMs > 0) {
      await new Promise((res) => setTimeout(res, this.motionDurationMs));
    }
    this.cycles += 1;
    this.transition('OPEN');

    if (this.antiTailgateTimeout) clearTimeout(this.antiTailgateTimeout);
    if (this.autoCloseDelayMs > 0) {
      this.antiTailgateTimeout = setTimeout(() => {
        if (this.state === 'OPEN' && !this.vehicleDetected && !this.obstruction) {
          void this.close();
        }
      }, this.autoCloseDelayMs);
    }
  }

  async close(): Promise<void> {
    if (this.fault) throw new Error('Boom barrier in FAULT state');
    if (this.emergency) throw new Error('Emergency active: Boom barrier kept upright');
    if (this.vehicleDetected || this.obstruction) {
      this.transition('STOPPED');
      throw new Error('Vehicle loop or obstruction active: Close aborted for safety');
    }

    this.transition('CLOSING');
    if (this.motionDurationMs > 0) {
      await new Promise((res) => setTimeout(res, this.motionDurationMs));
    }
    this.transition('CLOSED');
  }

  async stop(): Promise<void> {
    if (this.antiTailgateTimeout) clearTimeout(this.antiTailgateTimeout);
    this.transition('STOPPED');
  }

  async emergencyOverride(reason: string): Promise<void> {
    if (this.antiTailgateTimeout) clearTimeout(this.antiTailgateTimeout);
    this.emergency = true;
    this.obstruction = false;
    this.transition('OPEN');
  }

  clearEmergency(): void {
    this.emergency = false;
  }

  setVehicleLoop(detected: boolean): void {
    this.vehicleDetected = detected;
    if (detected && this.state === 'CLOSING') {
      this.transition('OPENING');
      this.transition('OPEN');
    }
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
      obstructionDetected: this.obstruction || this.vehicleDetected,
      emergencyActive: this.emergency,
      cyclesCount: this.cycles,
      lastStateChange: this.lastChange,
      metadata: {
        vehicleDetected: this.vehicleDetected,
        loopSensorHealthy: true,
      },
    };
  }

  simulateObstruction(obstructed: boolean): void {
    this.obstruction = obstructed;
    if (obstructed && this.state === 'CLOSING') {
      this.transition('STOPPED');
    }
  }

  simulateFault(fault: boolean): void {
    this.fault = fault;
    this.transition(fault ? 'FAULT' : 'CLOSED');
  }

  private transition(next: GateState): void {
    this.state = next;
    this.lastChange = new Date();
  }
}
