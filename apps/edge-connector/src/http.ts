import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import { CloudError } from './types';

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  /** Parsed JSON, or undefined when the body is empty. */
  json: unknown;
}

/** Injectable transport so tests never touch the network. */
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function parseBody(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CloudError('response body is not valid JSON');
  }
}

/** Global fetch with a hard timeout; used for the cloud API (public CA certificates). */
export function createFetchClient(timeoutMs: number): HttpClient {
  return {
    async request(req) {
      const res = await fetch(req.url, {
        method: req.method,
        headers: { 'content-type': 'application/json', ...req.headers },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      const headers: Record<string, string | undefined> = {};
      res.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      return { status: res.status, headers, json: parseBody(text.slice(0, MAX_BODY_BYTES)) };
    },
  };
}

/**
 * node:https client for on-site servers with self-signed certificates. A CA file is added to
 * the trust store for this client only; certificate verification is never switched off.
 */
export function createNodeHttpClient(timeoutMs: number, caFile?: string): HttpClient {
  const ca = caFile ? fs.readFileSync(caFile) : undefined;
  return {
    request(req) {
      return new Promise<HttpResponse>((resolve, reject) => {
        const url = new URL(req.url);
        const payload = req.body !== undefined ? JSON.stringify(req.body) : undefined;
        const mod = url.protocol === 'https:' ? https : http;
        const r = mod.request(
          url,
          {
            method: req.method,
            timeout: timeoutMs,
            headers: {
              'content-type': 'application/json',
              ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}),
              ...req.headers,
            },
            ...(ca && url.protocol === 'https:' ? { ca } : {}),
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_BODY_BYTES) {
                r.destroy(new CloudError('response too large'));
                return;
              }
              chunks.push(chunk);
            });
            res.on('end', () => {
              try {
                const headers: Record<string, string | undefined> = {};
                for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(',') : v;
                resolve({ status: res.statusCode ?? 0, headers, json: parseBody(Buffer.concat(chunks).toString('utf8')) });
              } catch (e) {
                reject(e);
              }
            });
          },
        );
        r.on('timeout', () => r.destroy(new CloudError(`request timed out after ${timeoutMs}ms`)));
        r.on('error', reject);
        if (payload !== undefined) r.write(payload);
        r.end();
      });
    },
  };
}
