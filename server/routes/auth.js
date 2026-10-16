import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import {
  createSession,
  destroySession,
  signSessionToken,
} from '../lib/sessions.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

// Registration: few accounts per address per hour
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: 'Too many accounts created from this address. Try again later.',
});
// Login: limited per address and username (stops guessing one account) and,
// more loosely, per address (stops trying many usernames)
const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: (req) =>
    `${req.ip}:${String(req.body?.username ?? '')
      .slice(0, 64)
      .toLowerCase()}`,
  message: 'Too many sign-in attempts. Try again in a few minutes.',
});
const loginAddressLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many sign-in attempts. Try again in a few minutes.',
});

// Checked against when the username doesn't exist, so a failed login takes as
// long whether or not the account exists (otherwise the response time reveals
// which usernames are registered)
const dummyHash = hashPassword('not-a-real-password');

const wrap = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

function validate(username, password) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return 'Username must be 3–20 letters, numbers or underscores.';
  }
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  return null;
}

router.post(
  '/register',
  registerLimiter,
  wrap(async (req, res) => {
    const { username, password } = req.body ?? {};
    const error = validate(username, password);
    if (error) return res.status(400).json({ error });

    try {
      // The user and its first session are created together, so a failure
      // can't leave the username taken without the user being signed in
      const user = await prisma.user.create({
        data: {
          username,
          passwordHash: await hashPassword(password),
          sessions: { create: {} },
        },
        include: { sessions: true },
      });
      const token = signSessionToken(user.sessions[0]);
      res.status(201).json({ token, user: { id: user.id, username } });
    } catch (err) {
      if (err.code === 'P2002') {
        return res
          .status(409)
          .json({ error: 'That username is already taken.' });
      }
      throw err;
    }
  })
);

router.post(
  '/login',
  loginAddressLimiter,
  loginAccountLimiter,
  wrap(async (req, res) => {
    const { username, password } = req.body ?? {};
    const user = await prisma.user.findUnique({
      where: { username: String(username ?? '') },
    });

    const ok = await verifyPassword(
      String(password ?? ''),
      user ? user.passwordHash : await dummyHash
    );
    if (!user || !ok) {
      return res.status(401).json({ error: 'Incorrect username or password.' });
    }

    const token = await createSession(user.id);
    res.json({ token, user: { id: user.id, username: user.username } });
  })
);

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.post(
  '/logout',
  requireAuth,
  wrap(async (req, res) => {
    await destroySession(req.sessionId);
    res.json({ ok: true });
  })
);

export default router;
