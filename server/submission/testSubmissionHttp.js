import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { createSession } from '../lib/sessions.js';

let userId = null;

try {
  const user = await prisma.user.create({
    data: {
      username: `http-test-${randomUUID()}`,
      passwordHash: 'TEST_ONLY_NOT_A_REAL_PASSWORD',
    },
  });

  userId = user.id;

  const token = await createSession(user.id);

  const response = await globalThis.fetch('http://localhost:5000/api/submit', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      teamId: 1,
      problemId: 1,
      codebase: {},
    }),
  });

  const result = await response.json();

  console.log('HTTP status:', response.status);
  console.log('Response:', result);

  assert.equal(response.status, 503);
  assert.equal(result.success, false);
  assert.equal(result.error, 'Submission grading is not yet available.');

  console.log('\nPASS: Authenticated submissions are disabled by default.');
} catch (error) {
  console.error('\nTEST FAILED:', error);
  process.exitCode = 1;
} finally {
  if (userId !== null) {
    try {
      await prisma.session.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
      console.log('Temporary test user and session removed.');
    } catch (error) {
      console.error('Cleanup failed:', error);
      process.exitCode = 1;
    }
  }

  await prisma.$disconnect();
}
