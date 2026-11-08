import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BioStar2Api, BioStar2Source, executeBioStarCommand, mapBioStarEvent, parseEventSearch } from '../src/biostar2';
import { BioStar2SourceConfig } from '../src/config';
import { parseCommands, parseOutcomes } from '../src/cloud';
import { HttpClient, HttpRequest, HttpResponse } from '../src/http';
import { FakeCloud, MemoryState, silentLog } from './helpers';

// Shape follows Suprema's documented EventCollection response; ids/codes here are test data only.
const fixture = {
  EventCollection: {
    rows: [
      { id: '9001', datetime: '2026-03-01T04:00:00.00Z', event_type_id: { code: '1' }, user_id: { user_id: '101', name: 'Resident A' }, device_id: { id: '5' } },
      { id: '9002', datetime: '2026-03-01T04:00:05.00Z', event_type_id: { code: 2 }, user_id: { user_id: '102' } },
      { id: '9003', datetime: '2026-03-01T04:00:09.00Z', event_type_id: { code: '2' } },
      { id: '9004', datetime: '2026-03-01T04:00:10.00Z', event_type_id: { code: '99' }, user_id: { user_id: '103' } },
      { datetime: 'x', event_type_id: { code: '1' } },
    ],
  },
  Response: { code: '0', message: 'Success' },
};

const cfg: BioStar2SourceConfig = {
  type: 'biostar2', name: 'b', deviceToken: 't', baseUrl: 'https://bs', loginId: 'admin', password: 'pw',
  pollIntervalSec: 5, batchSize: 50, doorId: '7',
  successCodes: { '1': 'FINGERPRINT' }, failureCodes: { '2': 'FACE' },
  cursorOperator: 4, eventCodeOperator: 6, initialLookbackHours: 24,
};

class FakeHttp implements HttpClient {
  requests: HttpRequest[] = [];
  constructor(private readonly handler: (r: HttpRequest) => HttpResponse) {}
  async request(r: HttpRequest): Promise<HttpResponse> {
    this.requests.push(r);
    return this.handler(r);
  }
}

describe('BioStar 2 parsing', () => {
  it('parses event rows and drops incomplete ones', () => {
    const rows = parseEventSearch(fixture);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[2], { id: '9003', datetime: '2026-03-01T04:00:09.00Z', eventCode: '2', userId: null });
  });
  it('maps success and failure codes, skipping unknown codes and anonymous events', () => {
    const events = parseEventSearch(fixture).map((r) => mapBioStarEvent(r, cfg));
    assert.deepEqual(events[0], { deviceUserId: '101', method: 'FINGERPRINT', occurredAt: '2026-03-01T04:00:00.000Z', matched: true, vendorEventId: '9001' });
    assert.equal(events[1]?.matched, false);
    assert.equal(events[2], null);
    assert.equal(events[3], null);
  });
  it('handles empty collections and rejects malformed bodies', () => {
    assert.deepEqual(parseEventSearch({ EventCollection: {} }), []);
    assert.throws(() => parseEventSearch({ nope: 1 }), /EventCollection/);
  });
});

describe('cloud response parsing', () => {
  it('requires one valid outcome per event', () => {
    assert.throws(() => parseOutcomes({ outcomes: [] }, 1), /count/);
    assert.throws(() => parseOutcomes({ outcomes: [{ status: 'MAYBE' }] }, 1), /status/);
    assert.deepEqual(parseOutcomes({ outcomes: [{ status: 'REJECTED', dedupeKey: 'k', reason: 'r' }] }, 1), [{ status: 'REJECTED', dedupeKey: 'k', reason: 'r' }]);
  });
  it('validates commands', () => {
    assert.equal(parseCommands({ commands: [{ id: 'a', kind: 'OPEN_DOOR', payload: {} }] }).length, 1);
    assert.throws(() => parseCommands({ commands: [{ id: 'a', kind: 'REBOOT' }] }));
  });
});

describe('BioStar 2 session and commands', () => {
  it('logs in, re-logs in once on 401, and sends the session header', async () => {
    let logins = 0;
    let first = true;
    const http = new FakeHttp((r) => {
      if (r.url.endsWith('/api/login')) {
        logins++;
        return { status: 200, headers: { 'bs-session-id': `s${logins}` }, json: undefined };
      }
      if (first) {
        first = false;
        return { status: 401, headers: {}, json: undefined };
      }
      return { status: 200, headers: {}, json: fixture };
    });
    const api = new BioStar2Api(http, cfg);
    const res = await api.call('POST', '/api/events/search', {});
    assert.equal(res.status, 200);
    assert.equal(logins, 2);
    assert.equal(http.requests.at(-1)?.headers?.['bs-session-id'], 's2');
  });

  it('executes commands and acks every one, including failures', async () => {
    const http = new FakeHttp((r) => {
      if (r.url.endsWith('/api/login')) return { status: 200, headers: { 'bs-session-id': 's' }, json: undefined };
      if (r.url.endsWith('/api/events/search')) return { status: 200, headers: {}, json: { EventCollection: { rows: [] } } };
      if (r.method === 'PUT') return { status: 404, headers: {}, json: undefined };
      if (r.method === 'POST' && r.url.endsWith('/api/users')) return { status: 200, headers: {}, json: undefined };
      if (r.method === 'DELETE') return { status: 404, headers: {}, json: undefined };
      if (r.url.endsWith('/api/doors/open')) return { status: 500, headers: {}, json: undefined };
      return { status: 400, headers: {}, json: undefined };
    });
    const cloud = new FakeCloud();
    cloud.commands = [
      { id: 'c1', kind: 'UPSERT_USER', payload: { deviceUserId: '5', name: 'Asha' } },
      { id: 'c2', kind: 'DELETE_USER', payload: { deviceUserId: '5' } },
      { id: 'c3', kind: 'OPEN_DOOR', payload: {} },
      { id: 'c4', kind: 'UPSERT_USER', payload: {} },
    ];
    const source = new BioStar2Source(cfg, new BioStar2Api(http, cfg), cloud, new MemoryState(), silentLog);
    await source.tick(new AbortController().signal);
    assert.deepEqual(cloud.acks.map((a) => [a.id, a.success]), [['c1', true], ['c2', true], ['c3', false], ['c4', false]]);
    const door = http.requests.find((r) => r.url.endsWith('/api/doors/open'));
    assert.deepEqual(door?.body, { DoorCollection: { rows: [{ id: '7' }] } });
  });

  it('refuses OPEN_DOOR without a configured door', async () => {
    const api = new BioStar2Api(new FakeHttp(() => ({ status: 200, headers: {}, json: undefined })), cfg);
    const r = await executeBioStarCommand(api, { id: 'x', kind: 'OPEN_DOOR', payload: {} }, undefined);
    assert.equal(r.success, false);
  });

  it('persists the cursor only after a successful post', async () => {
    const http = new FakeHttp((r) =>
      r.url.endsWith('/api/login')
        ? { status: 200, headers: { 'bs-session-id': 's' }, json: undefined }
        : { status: 200, headers: {}, json: fixture },
    );
    const cloud = new FakeCloud();
    cloud.failPost = new Error('down');
    const state = new MemoryState();
    const source = new BioStar2Source(cfg, new BioStar2Api(http, cfg), cloud, state, silentLog);
    await assert.rejects(() => source.tick(new AbortController().signal));
    assert.deepEqual(state.saves, []);
    cloud.failPost = null;
    await source.tick(new AbortController().signal);
    assert.deepEqual(state.saves, ['2026-03-01T04:00:10.000Z']);
  });
});
