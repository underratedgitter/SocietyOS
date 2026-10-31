import { GateController, GateState, GateTelemetry } from './gate-controller.interface';

export class SlidingGateAdapter implements GateController {
  public readonly type = 'SLIDING_GATE';
  private state: GateState = 'CLOSED';
  private motorOvercurrent = false;
  private limitSwitchOpen = false;
  private limitSwitchClosed = true;
  private manualClutchDisengaged = false;
  private emergency = false;
  private cycles = 0;
  private lastChange = new Date();

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly travelDurationMs = 60,
  ) {}

  async open(): Promise<void> {
    if (this.manualClutchDisengaged) {
      throw new Error('Motor decoupled: Manual clutch disengaged');
    }
    if (this.motorOvercurrent) {
      throw new Error('Motor overcurrent trip: Obstacle on rail');
    }

    this.limitSwitchClosed = false;
    this.transition('OPENING');
    if (this.travelDurationMs > 0) {
      await new Promise((res) => setTimeout(res, this.travelDurationMs));
    }
    this.limitSwitchOpen = true;
    this.cycles += 1;
    this.transition('OPEN');
  }

  async close(): Promise<void> {
    if (this.manualClutchDisengaged) {
      throw new Error('Motor decoupled: Manual clutch disengaged');
    }
    if (this.emergency) {
      throw new Error('Emergency active: Sliding gate locked open');
    }
    if (this.motorOvercurrent) {
      this.transition('STOPPED');
      throw new Error('Safety reverse triggered: Obstacle resistance on rail');
    }

    this.limitSwitchOpen = false;
    this.transition('CLOSING');
    if (this.travelDurationMs > 0) {
      await new Promise((res) => setTimeout(res, this.travelDurationMs));
    }
    this.limitSwitchClosed = true;
    this.transition('CLOSED');
  }

  async stop(): Promise<void> {
    this.transition('STOPPED');
  }

  async emergencyOverride(reason: string): Promise<void> {
    this.emergency = true;
    this.motorOvercurrent = false;
    this.limitSwitchOpen = true;
    this.limitSwitchClosed = false;
    this.transition('OPEN');
  }

  clearEmergency(): void {
    this.emergency = false;
  }

  setManualClutch(disengaged: boolean): void {
    this.manualClutchDisengaged = disengaged;
    if (disengaged) {
      this.transition('STOPPED');
    }
  }

  async getState(): Promise<GateState> {
    return this.state;
  }

  async getHealth(): Promise<boolean> {
    return !this.motorOvercurrent && !this.manualClutchDisengaged;
  }

  async getTelemetry(): Promise<GateTelemetry> {
    return {
      state: this.state,
      obstructionDetected: this.motorOvercurrent,
      emergencyActive: this.emergency,
      cyclesCount: this.cycles,
      lastStateChange: this.lastChange,
      metadata: {
        limitSwitchOpen: this.limitSwitchOpen,
        limitSwitchClosed: this.limitSwitchClosed,
        manualClutchDisengaged: this.manualClutchDisengaged,
      },
    };
  }

  simulateObstruction(obstructed: boolean): void {
    this.motorOvercurrent = obstructed;
    if (obstructed && (this.state === 'CLOSING' || this.state === 'OPENING')) {
      this.transition('STOPPED');
    }
  }

  simulateFault(fault: boolean): void {
    this.motorOvercurrent = fault;
    this.transition(fault ? 'FAULT' : 'CLOSED');
  }

  private transition(next: GateState): void {
    this.state = next;
    this.lastChange = new Date();
  }
}
