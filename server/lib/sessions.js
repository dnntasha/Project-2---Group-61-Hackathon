import jwt from 'jsonwebtoken';
import { prisma } from './prisma.js';

export const IDLE_LIMIT_MS = 30 * 60 * 1000;

export async function createSession(userId) {
  const session = await prisma.session.create({ data: { userId } });
  return jwt.sign({ sid: session.id, uid: userId }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });
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

  await prisma.session.update({
    where: { id: session.id },
    data: { lastActivity: new Date() },
  });

  const { id, username } = session.user;
  return { user: { id, username }, sessionId: session.id };
}

export async function destroySession(sessionId) {
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
}
