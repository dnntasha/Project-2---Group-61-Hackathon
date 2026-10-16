import { setInterval } from 'node:timers';
import jwt from 'jsonwebtoken';
import { prisma } from './prisma.js';

export const IDLE_LIMIT_MS = 30 * 60 * 1000;
// lastActivity is only written when it is at least this old, so requests and
// editor messages don't each cost a database write
const ACTIVITY_WRITE_INTERVAL_MS = 15 * 1000;
// Because of the interval above the stored lastActivity can be up to that much
// older than the real last activity. Allowing for it means a session is never
// cut off before it has really been idle for IDLE_LIMIT_MS.
const IDLE_TOLERANCE_MS = ACTIVITY_WRITE_INTERVAL_MS;
// How often sessions that are long past the idle limit are deleted
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

// Signs the token the client sends back with every request.
// The token deliberately has no expiry of its own: how long a sign-in lasts is
// decided by the Session row (30 minutes since the last activity, however long
// that keeps going), so a hard JWT expiry would only log active users out.
export function signSessionToken(session) {
  return jwt.sign(
    { sid: session.id, uid: session.userId },
    process.env.JWT_SECRET
  );
}

export async function createSession(userId) {
  const session = await prisma.session.create({ data: { userId } });
  return signSessionToken(session);
}

/**
 * Checks a session token and returns { user, sessionId }, or null if it is
 * invalid or the session has been idle for too long.
 *
 * Normally this counts as activity and extends the session. Pass
 * `{ touch: false }` for background checks (such as re-checking an open
 * WebSocket) that must not keep an otherwise idle session alive.
 */
export async function authenticate(token, { touch = true } = {}) {
  if (!token) return null;

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }

  const session = await prisma.session.findUnique({
    where: { id: payload.sid },
    include: { user: true },
  });
  if (!session) return null;

  const idleMs = Date.now() - session.lastActivity.getTime();
  if (idleMs > IDLE_LIMIT_MS + IDLE_TOLERANCE_MS) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  if (touch && idleMs > ACTIVITY_WRITE_INTERVAL_MS) {
    // updateMany doesn't throw if a concurrent logout already removed it
    const { count } = await prisma.session.updateMany({
      where: { id: session.id },
      data: { lastActivity: new Date() },
    });
    if (count === 0) return null;
  }

  const { id, username } = session.user;
  return { user: { id, username }, sessionId: session.id };
}

export async function destroySession(sessionId) {
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
}

// Deletes sessions that are past the idle limit. They could never be used
// again, but would otherwise stay in the table until someone presented them.
export async function deleteExpiredSessions() {
  const cutoff = new Date(Date.now() - IDLE_LIMIT_MS - IDLE_TOLERANCE_MS);
  const { count } = await prisma.session.deleteMany({
    where: { lastActivity: { lt: cutoff } },
  });
  return count;
}

// Runs deleteExpiredSessions now and then; returns the timer so it can be
// stopped. The timer is unref'd so it never keeps the process alive.
export function startSessionCleanup() {
  const run = () =>
    deleteExpiredSessions().catch((error) => {
      console.error('Could not delete expired sessions:', error);
    });
  run();
  return setInterval(run, CLEANUP_INTERVAL_MS).unref();
}
