import { authenticate } from '../lib/sessions.js';

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    const result = await authenticate(token);
    if (!result) {
      return res
        .status(401)
        .json({ error: 'Your session has expired. Sign in again.' });
    }

    req.user = result.user;
    req.sessionId = result.sessionId;
    next();
  } catch (err) {
    next(err);
  }
}
