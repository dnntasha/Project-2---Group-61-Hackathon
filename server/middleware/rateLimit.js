import { setInterval } from 'node:timers';

/**
 * A small in-memory fixed-window rate limiter.
 *
 * Each key (by default the client's IP address) may make `max` requests per
 * `windowMs`; further requests get a 429 with a Retry-After header until the
 * window ends. It slows down password guessing, mass registration and abuse of
 * the expensive endpoints (running code in Docker). State lives in this
 * process only, which is fine for a single server instance.
 *
 *   rateLimit({ windowMs: 60_000, max: 10, key: (req) => `user:${req.user.id}` })
 */
export function rateLimit({
  windowMs,
  max,
  key = (req) => req.ip,
  message = 'Too many requests. Please wait a while and try again.',
}) {
  // key -> { count, resetAt }
  const windows = new Map();

  // Forget windows that have ended so the map can't grow forever
  setInterval(
    () => {
      const now = Date.now();
      for (const [name, entry] of windows) {
        if (entry.resetAt <= now) windows.delete(name);
      }
    },
    Math.max(windowMs, 60_000)
  ).unref();

  return (req, res, next) => {
    // Lets automated tests and local load testing switch the limits off
    if (process.env.DISABLE_RATE_LIMIT === 'true') return next();

    const now = Date.now();
    const name = String(key(req));
    let entry = windows.get(name);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      windows.set(name, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }

    next();
  };
}
