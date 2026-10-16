import jwt from 'jsonwebtoken';
import { prisma } from './prisma.js';

export const IDLE_LIMIT_MS = 30 * 60 * 1000;
// lastActivity is only written when it is at least this old, so requests and
// editor messages don't each cost a database write
const ACTIVITY_WRITE_INTERVAL_MS = 60 * 1000;

// Signs the token the client sends back with every request
export function signSessionToken(session) {
  return jwt.sign(
    { sid: session.id, uid: session.userId },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

export async function createSession(userId) {
  const session = await prisma.session.create({ data: { userId } });
  return signSessionToken(session);
}

export async function authenticate(token) {
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

  if (Date.now() - session.lastActivity.getTime() > IDLE_LIMIT_MS) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  if (
    Date.now() - session.lastActivity.getTime() >
    ACTIVITY_WRITE_INTERVAL_MS
  ) {
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
