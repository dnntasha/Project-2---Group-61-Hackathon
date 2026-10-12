import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { completeSubmission, failSubmission } from './submissionResults.js';

let testUserId = null;

try {
  // Create temporary test records.
  const user = await prisma.user.create({
    data: {
      username: `results-test-${randomUUID()}`,
      passwordHash: 'TEST_ONLY_NOT_A_REAL_PASSWORD',
    },
  });

  testUserId = user.id;

  const group = await prisma.group.create({
    data: {
      name: `Results Test Group ${randomUUID()}`,
      adminId: user.id,
      maxTeamSize: 5,
    },
  });

  const team = await prisma.team.create({
    data: {
      name: 'Results Test Team',
      groupId: group.id,
      leaderId: user.id,
    },
  });

  const problem = await prisma.problem.create({
    data: {
      groupId: group.id,
      title: 'Results Test Problem',
      description: 'Temporary problem for testing submission results.',
      submissionLimit: 10,
    },
  });

  async function createPendingSubmission() {
    return prisma.submission.create({
      data: {
        teamId: team.id,
        problemId: problem.id,
        status: 'PENDING',
      },
    });
  }

  // TEST 1: Successful completion
  console.log('\nTEST 1: Complete a pending submission');

  const first = await createPendingSubmission();

  const completed = await completeSubmission({
    submissionId: first.id,
    scoreP: 85,
    scoreT: 12.5,
  });

  assert.equal(completed.success, true);
  assert.equal(completed.status, 200);
  assert.equal(completed.score.P, 85);
  assert.equal(completed.score.T, 12.5);

  const saved = await prisma.submission.findUnique({
    where: { id: first.id },
  });

  assert.equal(saved.status, 'COMPLETED');
  assert.equal(saved.scoreP, 85);
  assert.equal(saved.scoreT, 12.5);

  console.log('PASS: Completion and scores saved to database.');

  // TEST 2: Cannot complete twice
  console.log('\nTEST 2: Reject duplicate completion');

  const duplicate = await completeSubmission({
    submissionId: first.id,
    scoreP: 100,
    scoreT: 1,
  });

  assert.equal(duplicate.success, false);
  assert.equal(duplicate.status, 409);

  const unchanged = await prisma.submission.findUnique({
    where: { id: first.id },
  });

  assert.equal(unchanged.scoreP, 85);
  assert.equal(unchanged.scoreT, 12.5);

  console.log('PASS: Completed submission cannot be overwritten.');

  // TEST 3: Successful failure
  console.log('\nTEST 3: Fail a pending submission');

  const second = await createPendingSubmission();

  const failed = await failSubmission({
    submissionId: second.id,
  });

  assert.equal(failed.success, true);
  assert.equal(failed.status, 200);

  const savedFailure = await prisma.submission.findUnique({
    where: { id: second.id },
  });

  assert.equal(savedFailure.status, 'FAILED');
  assert.equal(savedFailure.scoreP, null);
  assert.equal(savedFailure.scoreT, null);

  console.log('PASS: Failed submission saved to database.');

  // TEST 4: Cannot complete a failed submission
  console.log('\nTEST 4: Reject completion after failure');

  const afterFailure = await completeSubmission({
    submissionId: second.id,
    scoreP: 75,
    scoreT: 20,
  });

  assert.equal(afterFailure.success, false);
  assert.equal(afterFailure.status, 409);

  console.log('PASS: Failed submission cannot be completed.');

  // TEST 5: Cannot fail a completed submission
  console.log('\nTEST 5: Reject failure after completion');

  const failCompleted = await failSubmission({
    submissionId: first.id,
  });

  assert.equal(failCompleted.success, false);
  assert.equal(failCompleted.status, 409);

  console.log('PASS: Completed submission cannot be failed.');

  // TEST 6: Invalid grading scores
  console.log('\nTEST 6: Reject invalid grading scores');

  const third = await createPendingSubmission();

  const invalidScores = [
    { scoreP: -1, scoreT: 10 },
    { scoreP: 101, scoreT: 10 },
    { scoreP: 50, scoreT: -1 },
    { scoreP: NaN, scoreT: 10 },
    { scoreP: 50, scoreT: Infinity },
  ];

  for (const scores of invalidScores) {
    const result = await completeSubmission({
      submissionId: third.id,
      ...scores,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 400);
  }

  const stillPending = await prisma.submission.findUnique({
    where: { id: third.id },
  });

  assert.equal(stillPending.status, 'PENDING');
  assert.equal(stillPending.scoreP, null);
  assert.equal(stillPending.scoreT, null);

  console.log('PASS: Invalid scores rejected without database changes.');

  // TEST 7: Invalid submission IDs
  console.log('\nTEST 7: Reject invalid submission IDs');

  for (const submissionId of [0, -1, 1.5, null, '123']) {
    const completeResult = await completeSubmission({
      submissionId,
      scoreP: 80,
      scoreT: 10,
    });

    const failResult = await failSubmission({
      submissionId,
    });

    assert.equal(completeResult.success, false);
    assert.equal(completeResult.status, 400);
    assert.equal(failResult.success, false);
    assert.equal(failResult.status, 400);
  }

  console.log('PASS: Invalid submission IDs rejected.');

  // TEST 8: Missing submission
  console.log('\nTEST 8: Reject nonexistent submission');

  const missingId = 2147483647;

  const missing = await completeSubmission({
    submissionId: missingId,
    scoreP: 80,
    scoreT: 10,
  });

  assert.equal(missing.success, false);
  assert.equal(missing.status, 409);

  console.log('PASS: Nonexistent submission rejected.');

  console.log('\nALL SUBMISSION RESULTS TESTS PASSED!');
} catch (error) {
  console.error('\nTEST FAILED:', error);
  process.exitCode = 1;
} finally {
  if (testUserId !== null) {
    try {
      const groups = await prisma.group.findMany({
        where: { adminId: testUserId },
        select: { id: true },
      });

      for (const group of groups) {
        await prisma.group.delete({ where: { id: group.id } });
      }

      await prisma.user.delete({ where: { id: testUserId } });

      console.log('Temporary test records removed.');
    } catch (cleanupError) {
      console.error('Cleanup failed:', cleanupError);
      process.exitCode = 1;
    }
  }

  await prisma.$disconnect();
}
