// Event timing rules, in one place.
// Pure functions: they only use the values passed in, so they are easy to test
// and every part of the server (groups, submissions, leaderboards) agrees.

export const EVENT_STATUS = {
  NOT_STARTED: 'not-started',
  RUNNING: 'running',
  ENDED: 'ended',
};

// When the event ends: start time + duration. null if it hasn't started.
export function getEndsAt(group) {
  if (!group.startedAt) return null;
  const start = new Date(group.startedAt).getTime();
  return new Date(start + group.durationMin * 60 * 1000);
}

// 'not-started', 'running' or 'ended'. The event ends exactly at endsAt.
export function getEventStatus(group, now = new Date()) {
  const endsAt = getEndsAt(group);
  if (!endsAt) return EVENT_STATUS.NOT_STARTED;
  return now < endsAt ? EVENT_STATUS.RUNNING : EVENT_STATUS.ENDED;
}

// Submissions are only accepted while the event is running.
export function isAcceptingSubmissions(group, now = new Date()) {
  return getEventStatus(group, now) === EVENT_STATUS.RUNNING;
}

// Milliseconds left (never negative). null if it hasn't started.
export function getTimeRemainingMs(group, now = new Date()) {
  const endsAt = getEndsAt(group);
  if (!endsAt) return null;
  return Math.max(0, endsAt.getTime() - now.getTime());
}
