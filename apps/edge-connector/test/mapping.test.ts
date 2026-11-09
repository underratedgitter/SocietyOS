import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapRow } from '../src/mapping';
import { toIsoWithOffset, wallClockFromUtcFields } from '../src/time';
import { normalizeRow } from '../src/db';
import { row, sqlConfig } from './helpers';

describe('toIsoWithOffset', () => {
  it('applies the configured zone to wall-clock times', () => {
    assert.equal(toIsoWithOffset('2026-03-01 09:30:00', 'Asia/Kolkata'), '2026-03-01T09:30:00.000+05:30');
    assert.equal(toIsoWithOffset('2026-01-15T23:59:59.5', 'America/New_York'), '2026-01-15T23:59:59.500-05:00');
  });
  it('uses the DST offset in effect at that instant', () => {
    assert.equal(toIsoWithOffset('2026-07-01 12:00:00', 'America/New_York'), '2026-07-01T12:00:00.000-04:00');
  });
  it('keeps strings that already carry an offset', () => {
    assert.equal(toIsoWithOffset('2026-03-01T09:30:00+05:30', 'UTC'), '2026-03-01T04:00:00.000Z');
  });
  it('rejects garbage and impossible dates', () => {
    assert.equal(toIsoWithOffset('not a date', 'UTC'), null);
    assert.equal(toIsoWithOffset('2026-02-31 10:00:00', 'UTC'), null);
    for (const date of ['2026-04-31T10:00:00Z', '2026-04-31T10:00:00+05:30', '2026-03-01T24:00:00', '2026-03-01T10:60:00', '2026-13-01T10:00:00']) {
      assert.equal(toIsoWithOffset(date, 'UTC'), null, date);
    }
  });
});

describe('mapRow', () => {
  it('maps vendor codes and converts time', () => {
    const r = mapRow(row(1, '101', 15), sqlConfig());
    assert.deepEqual(r, {
      ok: true,
      event: { deviceUserId: '101', method: 'FACE', occurredAt: '2026-03-01T09:30:00.000+05:30', matched: true },
    });
  });
  it('falls back to defaultMethod for unmapped codes', () => {
    const r = mapRow(row(1, '101', 99), sqlConfig());
    assert.ok(r.ok && r.event.method === 'UNKNOWN');
  });
  it('reads matched from a column and vendorEventId when configured', () => {
    const cfg = sqlConfig({ columns: { deviceUserId: 'emp_code', occurredAt: 'punch_time', method: 'verify_type', matched: 'ok', vendorEventId: 'id' } });
    const r = mapRow({ ...row(7), ok: 0 }, cfg);
    assert.ok(r.ok && r.event.matched === false && r.event.vendorEventId === '7');
  });
  it('rejects invalid user ids and times', () => {
    assert.equal(mapRow(row(1, 'bad id!'), sqlConfig()).ok, false);
    assert.equal(mapRow({ ...row(1), punch_time: 'x' }, sqlConfig()).ok, false);
    assert.equal(mapRow({ ...row(1), emp_code: null }, sqlConfig()).ok, false);
  });
  it('matches column names case-insensitively', () => {
    assert.equal(mapRow({ ID: 1, EMP_CODE: '5', PUNCH_TIME: '2026-03-01 09:30:00', VERIFY_TYPE: 1 }, sqlConfig()).ok, true);
  });
});

describe('normalizeRow', () => {
  it('renders mssql Dates as wall-clock text and others as ISO', () => {
    const d = new Date(Date.UTC(2026, 2, 1, 9, 30, 0));
    assert.equal(wallClockFromUtcFields(d), '2026-03-01T09:30:00.000');
    assert.equal(normalizeRow({ t: d }, true)['t'], '2026-03-01T09:30:00.000');
    assert.equal(normalizeRow({ t: d }, false)['t'], '2026-03-01T09:30:00.000Z');
    assert.equal(normalizeRow({ n: 10n }, true)['n'], '10');
  });
});
