export type LogFields = Record<string, string | number | boolean | undefined>;
export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/** Keeps the first/last char only so logs help debugging without exposing resident identities. */
export function maskId(id: string): string {
  return id.length <= 2 ? '**' : `${id[0]}***${id[id.length - 1]}`;
}

export function createLogger(scope: string): Logger {
  const write = (level: string, msg: string, fields?: LogFields): void => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, scope, msg, ...fields });
    (level === 'info' ? process.stdout : process.stderr).write(line + '\n');
  };
  return {
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

/** Driver errors can echo connection strings or passwords, so known secrets are scrubbed. */
export function errorMessage(error: unknown, secrets: readonly string[] = []): string {
  let text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const secret of secrets) {
    if (secret.length >= 4) text = text.split(secret).join('[redacted]');
  }
  return text.slice(0, 300);
}
