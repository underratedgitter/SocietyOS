import { GateController, GateState, GateTelemetry } from './gate-controller.interface';

export class DoorLockAdapter implements GateController {
  public readonly type = 'DOOR_LOCK';
  private state: GateState = 'CLOSED';
  private fireAlarmTriggered = false;
  private doorHeldOpen = false;
  private auxiliaryRelease = false;
  private cycles = 0;
  private lastChange = new Date();

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly unlockHoldMs = 40,
  ) {}

  async open(): Promise<void> {
    // Electromagnetic locks are fail-safe: cutting current unlatches the door
    this.transition('OPENING');
    if (this.unlockHoldMs > 0) {
      await new Promise((res) => setTimeout(res, this.unlockHoldMs));
    }
    this.cycles += 1;
    this.transition('OPEN');
  }

  async close(): Promise<void> {
    if (this.fireAlarmTriggered) {
      throw new Error('Fail-safe active: Fire alarm trip keeps magnetic door unlocked');
    }
    if (this.doorHeldOpen) {
      throw new Error('Door contact open: Door physically held open');
    }

    this.transition('CLOSING');
    this.transition('CLOSED');
  }

  async stop(): Promise<void> {
    this.transition('STOPPED');
  }

  async emergencyOverride(reason: string): Promise<void> {
    this.fireAlarmTriggered = true;
    this.transition('OPEN');
  }

  clearEmergency(): void {
    this.fireAlarmTriggered = false;
  }

  setDoorHeldOpen(held: boolean): void {
    this.doorHeldOpen = held;
    if (held && this.state === 'CLOSED') {
      this.transition('FAULT'); // Held-open tamper alarm
    }
  }

  async getState(): Promise<GateState> {
    return this.state;
  }

  async getHealth(): Promise<boolean> {
    return !this.fireAlarmTriggered && !this.doorHeldOpen;
  }

  async getTelemetry(): Promise<GateTelemetry> {
    return {
      state: this.state,
      obstructionDetected: this.doorHeldOpen,
      emergencyActive: this.fireAlarmTriggered,
      cyclesCount: this.cycles,
      lastStateChange: this.lastChange,
      metadata: {
        failSafeMode: 'ENERGIZED_TO_LOCK',
        fireAlarmTriggered: this.fireAlarmTriggered,
        doorHeldOpen: this.doorHeldOpen,
      },
    };
  }

  simulateObstruction(obstructed: boolean): void {
    this.setDoorHeldOpen(obstructed);
  }

  simulateFault(fault: boolean): void {
    if (fault) {
      this.transition('FAULT');
    } else {
      this.transition('CLOSED');
    }
  }

  private transition(next: GateState): void {
    this.state = next;
    this.lastChange = new Date();
  }
}
