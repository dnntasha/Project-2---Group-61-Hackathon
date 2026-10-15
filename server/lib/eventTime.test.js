// Run with: npm test   (uses Node's built-in test runner, no extra library)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_STATUS,
  getEndsAt,
  getEventStatus,
  getTimeRemainingMs,
  isAcceptingSubmissions,
} from './eventTime.js';

const start = new Date('2026-10-13T09:00:00Z');
const group = { startedAt: start, durationMin: 120 }; // ends 11:00
const notStarted = { startedAt: null, durationMin: 120 };
const at = (time) => new Date(`2026-10-13T${time}Z`);

test('end time is start + duration', () => {
  assert.deepEqual(getEndsAt(group), at('11:00:00'));
  assert.equal(getEndsAt(notStarted), null);
});

test('status before, during and after the event', () => {
  assert.equal(
    getEventStatus(notStarted, at('10:00:00')),
    EVENT_STATUS.NOT_STARTED
  );
  assert.equal(getEventStatus(group, at('09:00:00')), EVENT_STATUS.RUNNING);
  assert.equal(getEventStatus(group, at('10:59:59')), EVENT_STATUS.RUNNING);
  assert.equal(getEventStatus(group, at('11:00:00')), EVENT_STATUS.ENDED);
});

test('submissions only while running', () => {
  assert.equal(isAcceptingSubmissions(notStarted, at('10:00:00')), false);
  assert.equal(isAcceptingSubmissions(group, at('10:30:00')), true);
  assert.equal(isAcceptingSubmissions(group, at('11:00:00')), false);
});

test('time remaining never goes negative', () => {
  assert.equal(getTimeRemainingMs(group, at('10:30:00')), 30 * 60 * 1000);
  assert.equal(getTimeRemainingMs(group, at('12:00:00')), 0);
  assert.equal(getTimeRemainingMs(notStarted, at('10:00:00')), null);
});

test('works with dates stored as strings', () => {
  const fromJson = { startedAt: start.toISOString(), durationMin: 30 };
  assert.deepEqual(getEndsAt(fromJson), at('09:30:00'));
});
