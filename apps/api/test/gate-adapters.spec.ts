import { SimulatedGateAdapter } from '../src/devices/adapters/simulated-gate.adapter';
import { BoomBarrierAdapter } from '../src/devices/adapters/boom-barrier.adapter';
import { SlidingGateAdapter } from '../src/devices/adapters/sliding-gate.adapter';
import { DoorLockAdapter } from '../src/devices/adapters/door-lock.adapter';
import { GateAdapterFactory } from '../src/devices/adapters/gate-adapter.factory';

describe('Gate Adapters and Controller State Machines (Unit)', () => {
  describe('SimulatedGateAdapter', () => {
    it('executes normal open -> close lifecycle and records cycles', async () => {
      const gate = new SimulatedGateAdapter('sim-1', 'Main Barrier', 0);
      expect(await gate.getState()).toBe('CLOSED');
      expect(await gate.getHealth()).toBe(true);

      await gate.open();
      expect(await gate.getState()).toBe('OPEN');

      await gate.close();
      expect(await gate.getState()).toBe('CLOSED');

      const telemetry = await gate.getTelemetry();
      expect(telemetry.cyclesCount).toBe(1);
      expect(telemetry.emergencyActive).toBe(false);
    });

    it('stops close movement when obstruction is detected', async () => {
      const gate = new SimulatedGateAdapter('sim-2', 'East Gate', 0);
      await gate.open();

      gate.simulateObstruction(true);
      await expect(gate.close()).rejects.toThrow(/Obstruction detected/);
      expect(await gate.getState()).toBe('STOPPED');
    });

    it('allows emergency override to force open and ignore obstruction', async () => {
      const gate = new SimulatedGateAdapter('sim-3', 'Pedestrian Gate', 0);
      gate.simulateObstruction(true);

      await gate.emergencyOverride('FIRE_ALARM');
      expect(await gate.getState()).toBe('OPEN');

      const telemetry = await gate.getTelemetry();
      expect(telemetry.emergencyActive).toBe(true);

      await expect(gate.close()).rejects.toThrow(/Emergency override active/);
    });
  });

  describe('BoomBarrierAdapter', () => {
    it('opens on authorized command and respects vehicle loop detector', async () => {
      const barrier = new BoomBarrierAdapter('bb-1', 'Vehicle Inbound', 0, 0);
      expect(barrier.type).toBe('BOOM_BARRIER');
      await barrier.open();
      expect(await barrier.getState()).toBe('OPEN');

      barrier.setVehicleLoop(true);
      const telemetry = await barrier.getTelemetry();
      expect(telemetry.obstructionDetected).toBe(true);

      // Should refuse to close while car is in loop
      await expect(barrier.close()).rejects.toThrow(/Vehicle loop or obstruction active/);

      // Car leaves loop
      barrier.setVehicleLoop(false);
      await barrier.close();
      expect(await barrier.getState()).toBe('CLOSED');
    });

    it('transitions to fault and rejects commands', async () => {
      const barrier = new BoomBarrierAdapter('bb-2', 'Exit Barrier', 0, 0);
      barrier.simulateFault(true);
      expect(await barrier.getHealth()).toBe(false);
      expect(await barrier.getState()).toBe('FAULT');
      await expect(barrier.open()).rejects.toThrow(/FAULT/);
    });
  });

  describe('SlidingGateAdapter', () => {
    it('tracks limit switches across opening and closing travel', async () => {
      const sliding = new SlidingGateAdapter('sg-1', 'Perimeter Sliding', 0);
      expect(sliding.type).toBe('SLIDING_GATE');

      await sliding.open();
      expect(await sliding.getState()).toBe('OPEN');
      let telem = await sliding.getTelemetry();
      expect(telem.metadata?.limitSwitchOpen).toBe(true);

      await sliding.close();
      expect(await sliding.getState()).toBe('CLOSED');
      telem = await sliding.getTelemetry();
      expect(telem.metadata?.limitSwitchClosed).toBe(true);
    });

    it('stops when manual clutch is disengaged for maintenance', async () => {
      const sliding = new SlidingGateAdapter('sg-2', 'Service Gate', 0);
      sliding.setManualClutch(true);
      expect(await sliding.getHealth()).toBe(false);
      await expect(sliding.open()).rejects.toThrow(/Manual clutch disengaged/);
    });
  });

  describe('DoorLockAdapter', () => {
    it('supports fail-safe release on emergency fire override', async () => {
      const lock = new DoorLockAdapter('dl-1', 'Clubhouse Door', 0);
      expect(lock.type).toBe('DOOR_LOCK');

      await lock.open();
      expect(await lock.getState()).toBe('OPEN');

      await lock.close();
      expect(await lock.getState()).toBe('CLOSED');

      await lock.emergencyOverride('BUILDING_FIRE_RELEASE');
      expect(await lock.getState()).toBe('OPEN');
      await expect(lock.close()).rejects.toThrow(/Fire alarm trip keeps magnetic door unlocked/);
    });

    it('detects door-held-open alarm condition', async () => {
      const lock = new DoorLockAdapter('dl-2', 'Stairwell Door', 0);
      lock.setDoorHeldOpen(true);
      expect(await lock.getState()).toBe('FAULT');
      expect(await lock.getHealth()).toBe(false);
    });
  });

  describe('GateAdapterFactory', () => {
    it('instantiates and caches proper adapter class by gate type', () => {
      const factory = new GateAdapterFactory();

      const barrier = factory.getOrCreate('ap-1', 'Barrier North', 'BOOM_BARRIER');
      expect(barrier.type).toBe('BOOM_BARRIER');

      const door = factory.getOrCreate('ap-2', 'Gym Door', 'DOOR_LOCK');
      expect(door.type).toBe('DOOR_LOCK');

      const sliding = factory.getOrCreate('ap-3', 'Service Gate', 'SLIDING_GATE');
      expect(sliding.type).toBe('SLIDING_GATE');

      // Returns same instance for same access point
      expect(factory.get('ap-1')).toBe(barrier);
    });
  });
});
