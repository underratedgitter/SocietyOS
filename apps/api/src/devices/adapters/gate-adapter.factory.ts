import { Injectable } from '@nestjs/common';
import { GateController } from './gate-controller.interface';
import { SimulatedGateAdapter } from './simulated-gate.adapter';
import { BoomBarrierAdapter } from './boom-barrier.adapter';
import { SlidingGateAdapter } from './sliding-gate.adapter';
import { DoorLockAdapter } from './door-lock.adapter';
import { SupremaAdapter } from './suprema.adapter';
import { ZKTecoAdapter } from './zkteco.adapter';

@Injectable()
export class GateAdapterFactory {
  private readonly registry = new Map<string, GateController>();

  getOrCreate(accessPointId: string, name: string, type: string): GateController {
    const existing = this.registry.get(accessPointId);
    if (existing) return existing;

    const adapter = this.createAdapter(accessPointId, name, type);
    this.registry.set(accessPointId, adapter);
    return adapter;
  }

  get(accessPointId: string): GateController | undefined {
    return this.registry.get(accessPointId);
  }

  private createAdapter(id: string, name: string, type: string): GateController {
    switch (type.toUpperCase()) {
      case 'BOOM_BARRIER':
        return new BoomBarrierAdapter(id, name);
      case 'SLIDING_GATE':
        return new SlidingGateAdapter(id, name);
      case 'DOOR_LOCK':
        return new DoorLockAdapter(id, name);
      case 'SUPREMA':
      case 'SUPREMA_BIOSTAR':
        return new SupremaAdapter(id, name);
      case 'ZKTECO':
      case 'ZKTECO_ZKFINGER':
        return new ZKTecoAdapter(id, name);
      case 'SIMULATED':
      default:
        return new SimulatedGateAdapter(id, name);
    }
  }
}
