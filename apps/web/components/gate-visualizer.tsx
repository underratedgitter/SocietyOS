'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Shield, Lock, Unlock } from 'lucide-react';

export type VisualGateState = 'CLOSED' | 'OPENING' | 'OPEN' | 'CLOSING' | 'STOPPED' | 'FAULT';
export type VisualGateType = 'BOOM_BARRIER' | 'SLIDING_GATE' | 'DOOR_LOCK';

interface GateVisualizerProps {
  state: VisualGateState;
  type?: VisualGateType | string;
  name?: string;
  location?: string | null;
  sensorClear?: boolean;
  emergencyActive?: boolean;
  interactive?: boolean;
  onOpenPulse?: () => void;
  onEmergencyHold?: () => void;
  onResetGate?: () => void;
}

export function GateVisualizer({
  state,
  type = 'BOOM_BARRIER',
  name = 'Main Access Gate',
  location,
  sensorClear = true,
  emergencyActive = false,
  interactive = false,
  onOpenPulse,
  onEmergencyHold,
  onResetGate,
}: GateVisualizerProps) {
  const [pulseSeconds, setPulseSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (state === 'OPEN' && !emergencyActive) {
      setPulseSeconds(6);
      const timer = window.setInterval(() => {
        setPulseSeconds((prev) => {
          if (prev === null || prev <= 1) {
            window.clearInterval(timer);
            return null;
          }
          return prev - 1;
        });
      }, 1000);
      return () => window.clearInterval(timer);
    } else {
      setPulseSeconds(null);
    }
  }, [state, emergencyActive]);

  const isBarrier = type === 'BOOM_BARRIER';
  const isSliding = type === 'SLIDING_GATE';
  const isOpen = state === 'OPEN';
  const isTransitioning = state === 'OPENING' || state === 'CLOSING';

  // Status badge colors
  const statusColor = emergencyActive
    ? 'var(--danger)'
    : state === 'OPEN' || state === 'OPENING'
    ? 'var(--success)'
    : state === 'FAULT' || state === 'STOPPED'
    ? 'var(--danger)'
    : 'var(--amber)';

  return (
    <div className="gate-viz-card">
      <div className="gate-viz-header">
        <div>
          <div className="gate-viz-tag">
            <span className="live-dot" style={{ background: statusColor }} />
            <span>{name}</span>
            {location && <span className="gate-viz-loc">· {location}</span>}
          </div>
          <div className="gate-viz-type-label">
            {isBarrier ? 'Automatic Boom Barrier' : isSliding ? 'Motorized Sliding Gate' : 'Electromagnetic Door'}
          </div>
        </div>
        <div className="gate-viz-status-badge" style={{ borderColor: statusColor, color: statusColor }}>
          {emergencyActive ? 'EMERGENCY HOLD' : state}
          {pulseSeconds !== null && ` (${pulseSeconds}s)`}
        </div>
      </div>

      <div className="gate-viz-stage">
        {/* Road & Ground Backdrop */}
        <div className="gate-ground-line" />
        <div className="gate-road-markings">
          <span />
          <span />
          <span />
        </div>

        {/* Boom Barrier Rendering */}
        {isBarrier && (
          <div className="barrier-assembly">
            {/* Pedestal */}
            <div className="barrier-pedestal">
              <div className="pedestal-cap" />
              <div
                className="pedestal-indicator"
                style={{
                  background: isOpen ? '#10b981' : state === 'OPENING' || state === 'CLOSING' ? '#f59e0b' : '#ef4444',
                  boxShadow: isOpen
                    ? '0 0 12px #10b981'
                    : state === 'OPENING'
                    ? '0 0 12px #f59e0b'
                    : '0 0 8px #ef4444',
                }}
              />
              <div className="pedestal-vent" />
            </div>

            {/* Arm Axis Pivot */}
            <div
              className={`barrier-arm-pivot ${state.toLowerCase()}`}
              style={{
                transform:
                  state === 'OPEN'
                    ? 'rotate(-78deg)'
                    : state === 'OPENING'
                    ? 'rotate(-45deg)'
                    : state === 'CLOSING'
                    ? 'rotate(-30deg)'
                    : 'rotate(0deg)',
                transition: 'transform 1.8s cubic-bezier(0.34, 1.3, 0.64, 1)',
              }}
            >
              <div className="barrier-arm-blade">
                {/* Red/White Stripes */}
                <div className="stripe red" />
                <div className="stripe white" />
                <div className="stripe red" />
                <div className="stripe white" />
                <div className="stripe red" />
                <div className="stripe white" />
                <div className="stripe red" />
                {/* End Tip LED */}
                <div
                  className="arm-tip-led"
                  style={{
                    background: isOpen ? '#10b981' : '#ef4444',
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Sliding Gate Rendering */}
        {isSliding && (
          <div className="sliding-assembly">
            <div className="sliding-track" />
            <div
              className="sliding-leaf"
              style={{
                transform:
                  state === 'OPEN'
                    ? 'translateX(-85%)'
                    : state === 'OPENING'
                    ? 'translateX(-45%)'
                    : 'translateX(0%)',
                transition: 'transform 2s ease-in-out',
              }}
            >
              <div className="gate-picket" />
              <div className="gate-picket" />
              <div className="gate-picket" />
              <div className="gate-picket" />
              <div className="gate-picket" />
              <div className="gate-picket" />
            </div>
            <div className="sliding-post" />
          </div>
        )}

        {/* Door Lock Rendering */}
        {!isBarrier && !isSliding && (
          <div className="doorlock-assembly">
            <div className="doorlock-frame">
              <div
                className="maglock-header"
                style={{
                  background: isOpen ? '#10b981' : '#dc2626',
                  boxShadow: isOpen ? '0 0 10px #10b981' : '0 0 8px #dc2626',
                }}
              >
                {isOpen ? <Unlock size={14} color="#fff" /> : <Lock size={14} color="#fff" />}
              </div>
              <div
                className="doorlock-leaf"
                style={{
                  transform: isOpen ? 'perspective(600px) rotateY(-45deg)' : 'rotateY(0deg)',
                  transition: 'transform 1.4s ease',
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Sensor & Telemetry Strip */}
      <div className="gate-viz-telemetry">
        <div className="telemetry-item">
          <span className="telemetry-label">Obstruction Sensor:</span>
          <span className={`telemetry-val ${sensorClear ? 'ok' : 'alert'}`}>
            {sensorClear ? 'CLEAR (Path Free)' : 'OBJECT DETECTED'}
          </span>
        </div>
        <div className="telemetry-item">
          <span className="telemetry-label">Safety Interlock:</span>
          <span className="telemetry-val ok">ENGAGED</span>
        </div>
        <div className="telemetry-item">
          <span className="telemetry-label">Drive Relay:</span>
          <span className="telemetry-val">{isTransitioning ? 'PULSING' : 'IDLE'}</span>
        </div>
      </div>

      {/* Interactive Controls (For Guards & Admins) */}
      {interactive && (
        <div className="gate-viz-controls">
          <button
            type="button"
            className="btn btn-small btn-primary"
            onClick={onOpenPulse}
            disabled={state === 'OPEN' || isTransitioning}
          >
            Open Gate Pulse (10s)
          </button>
          <button
            type="button"
            className={`btn btn-small ${emergencyActive ? 'btn-danger' : ''}`}
            onClick={onEmergencyHold}
            style={emergencyActive ? { fontWeight: 600 } : {}}
          >
            {emergencyActive ? 'Release Emergency Hold' : 'Emergency Egress Hold'}
          </button>
          {onResetGate && (
            <button type="button" className="btn btn-small btn-ghost" onClick={onResetGate}>
              Reset State
            </button>
          )}
        </div>
      )}
    </div>
  );
}
