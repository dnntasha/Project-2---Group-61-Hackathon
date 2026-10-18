import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rateLimit } from './rateLimit.js';

// Calls the middleware like Express would and reports what it did
function call(limiter, req = { ip: '1.2.3.4' }) {
  const result = { nextCalled: false, status: null, headers: {}, body: null };
  const res = {
    set(name, value) {
      result.headers[name] = value;
      return res;
    },
    status(code) {
      result.status = code;
      return res;
    },
    json(body) {
      result.body = body;
      return res;
    },
  };
  limiter(req, res, () => {
    result.nextCalled = true;
  });
  return result;
}

test('allows requests up to the limit, then answers 429 with Retry-After', () => {
  const limiter = rateLimit({ windowMs: 60_000, max: 2 });

  assert.equal(call(limiter).nextCalled, true);
  assert.equal(call(limiter).nextCalled, true);

  const blocked = call(limiter);
  assert.equal(blocked.nextCalled, false);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['Retry-After']) > 0);
  assert.match(blocked.body.error, /Too many/);
});

test('counts each key separately', () => {
  const limiter = rateLimit({
    windowMs: 60_000,
    max: 1,
    key: (req) => req.user,
  });

  assert.equal(call(limiter, { user: 'a' }).nextCalled, true);
  assert.equal(call(limiter, { user: 'a' }).nextCalled, false);
  assert.equal(call(limiter, { user: 'b' }).nextCalled, true);
});

test('a new window starts after the old one ends', async () => {
  const limiter = rateLimit({ windowMs: 30, max: 1 });

  assert.equal(call(limiter).nextCalled, true);
  assert.equal(call(limiter).nextCalled, false);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(call(limiter).nextCalled, true);
});

test('can be switched off for automated testing', () => {
  const limiter = rateLimit({ windowMs: 60_000, max: 1 });
  process.env.DISABLE_RATE_LIMIT = 'true';
  try {
    assert.equal(call(limiter).nextCalled, true);
    assert.equal(call(limiter).nextCalled, true);
  } finally {
    delete process.env.DISABLE_RATE_LIMIT;
  }
});
