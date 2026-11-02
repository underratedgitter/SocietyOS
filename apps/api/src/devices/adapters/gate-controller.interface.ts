// SocietyOS — Normalized Gate Controller Interface (Implementation Blueprint v1.0, Section 7)

export type GateState =
  | 'CLOSED'
  | 'OPENING'
  | 'OPEN'
  | 'CLOSING'
  | 'STOPPED'
  | 'FAULT'
  | 'UNKNOWN';

export type GateCommandType = 'OPEN' | 'CLOSE' | 'STOP' | 'EMERGENCY_OVERRIDE';

export interface GateTelemetry {
  state: GateState;
  obstructionDetected: boolean;
  emergencyActive: boolean;
  cyclesCount: number;
  lastStateChange: Date;
  metadata?: Record<string, unknown>;
}

export interface GateController {
  readonly id: string;
  readonly name: string;
  readonly type: string;

  open(): Promise<void>;
  close(): Promise<void>;
  stop(): Promise<void>;
  emergencyOverride(reason: string): Promise<void>;
  getState(): Promise<GateState>;
  getHealth(): Promise<boolean>;
  getTelemetry(): Promise<GateTelemetry>;
  simulateObstruction?(obstructed: boolean): void;
  simulateFault?(fault: boolean): void;
  clearEmergency?(): void;
}
