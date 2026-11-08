import type { ReactElement } from 'react';
import type { DeviceProtocol } from '@/lib/types';

export const PROTOCOL_OPTIONS: { value: DeviceProtocol; label: string }[] = [
  { value: 'NATIVE', label: 'SocietyOS gate controller' },
  { value: 'ZKTECO_ADMS', label: 'ZKTeco / eSSL / Realtime (ADMS push)' },
  { value: 'HIKVISION_ISAPI', label: 'Hikvision' },
  { value: 'DAHUA_HTTP', label: 'Dahua' },
  { value: 'SUPREMA_BIOSTAR2', label: 'Suprema BioStar 2 (via edge connector)' },
  { value: 'MATRIX_COSEC', label: 'Matrix COSEC (via edge connector)' },
  { value: 'GENERIC_WEBHOOK', label: 'Other brand via edge connector / webhook' },
];

const MAX_PUSH_IPS = 16;

function isIPv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isIPv6(value: string): boolean {
  if (!value.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(value)) return false;
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

export interface ParsedIps {
  ips: string[];
  error: string;
}

/** Parses a comma, space or newline separated list; reports the first problem found. */
export function parseAllowedIps(raw: string): ParsedIps {
  const ips = Array.from(new Set(raw.split(/[\s,]+/).filter(Boolean)));
  if (ips.length > MAX_PUSH_IPS) return { ips, error: `Use at most ${MAX_PUSH_IPS} addresses.` };
  const bad = ips.find((ip) => !isIPv4(ip) && !isIPv6(ip));
  return { ips, error: bad ? `"${bad}" is not a valid IPv4 or IPv6 address.` : '' };
}

export function DeviceSetupInstructions({
  protocol,
  token,
  host,
}: {
  protocol: DeviceProtocol;
  token: string;
  host: string;
}): ReactElement {
  const pushUrl = `https://${host}/api/v1/device-api/push/${token}/${protocol === 'DAHUA_HTTP' ? 'dahua' : 'hikvision'}`;
  return (
    <section aria-label="Terminal setup instructions" data-testid="device-setup-instructions" style={{ marginTop: 12 }}>
      <h3 className="panel-title">Set up the terminal</h3>
      {protocol === 'ZKTECO_ADMS' ? (
        <ol className="hint">
          <li>On the terminal open Comm. / Cloud Server Setting (ADMS).</li>
          <li>Set the server address to <strong>{host}</strong> and the port to <strong>443</strong> (HTTPS on).</li>
          <li>The Device UID you entered must equal the terminal&apos;s serial number.</li>
        </ol>
      ) : protocol === 'HIKVISION_ISAPI' || protocol === 'DAHUA_HTTP' ? (
        <>
          <p className="hint">Configure the terminal&apos;s HTTP event push (listening host) to this URL:</p>
          <code className="small" style={{ wordBreak: 'break-all' }}>{pushUrl}</code>
        </>
      ) : protocol === 'NATIVE' ? (
        <p className="hint">Store the device token and command secret in the SocietyOS controller configuration.</p>
      ) : (
        <p className="hint">
          Put this device token in the edge connector configuration. The connector runs on site, talks to the terminal
          and forwards normalized events to SocietyOS.
        </p>
      )}
    </section>
  );
}
