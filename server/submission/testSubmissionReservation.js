import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { reserveSubmission } from './submissionReservation.js';

let testUserId = null;

try {
  const user = await prisma.user.create({
    data: {
      username: `reservation-test-${randomUUID()}`,
      passwordHash: 'TEST_ONLY_NOT_A_REAL_PASSWORD',
    },
  });

  testUserId = user.id;

  const group = await prisma.group.create({
    data: {
      name: `Test Group ${randomUUID()}`,
      adminId: user.id,
      maxTeamSize: 5,
    },
  });

  const team = await prisma.team.create({
    data: {
      name: 'Reservation Test Team',
      groupId: group.id,
      leaderId: user.id,
    },
  });

  const problem = await prisma.problem.create({
    data: {
      groupId: group.id,
      title: 'Reservation Test Problem',
      description: 'Temporary problem for testing.',
      submissionLimit: 2,
      testCases: {
        create: {
          input: '1',
          expectedOutput: '1',
        },
      },
    },
  });

  const request = {
    userId: user.id,
    teamId: team.id,
    problemId: problem.id,
  };
  console.log('\nTesting unauthorized user...');

  const unauthorized = await reserveSubmission({
    ...request,
    userId: user.id + 999999,
  });

  assert.equal(unauthorized.success, false);

  console.log('PASS: Non-leader cannot reserve a submission.');

  console.log('\nTesting cross-group problem access...');

  const otherGroup = await prisma.group.create({
    data: {
      name: `Other Test Group ${randomUUID()}`,
      adminId: user.id,
      maxTeamSize: 5,
    },
  });

  const otherProblem = await prisma.problem.create({
    data: {
      groupId: otherGroup.id,
      title: 'Other Group Problem',
      description: 'Must not be accessible to the first team.',
      submissionLimit: 2,
      testCases: {
        create: {
          input: '2',
          expectedOutput: '2',
        },
      },
    },
  });

  const crossGroup = await reserveSubmission({
    ...request,
    problemId: otherProblem.id,
  });

  assert.equal(crossGroup.success, false);

  const rejectedSubmissionCount = await prisma.submission.count({
    where: { teamId: team.id },
  });

  assert.equal(rejectedSubmissionCount, 0);

  console.log('PASS: Cross-group submission rejected.');
  console.log('PASS: Rejected requests created no submissions.');

  console.log('Testing first reservation...');
  const first = await reserveSubmission(request);
  assert.equal(first.success, true);
  console.log('First:', first);

  console.log('\nTesting second reservation...');
  const second = await reserveSubmission(request);
  assert.equal(second.success, true);
  console.log('Second:', second);

  assert.equal(typeof first.submissionId, 'number');
  assert.equal(typeof second.submissionId, 'number');

  assert.notEqual(
    first.submissionId,
    second.submissionId,
    'Each reservation must have a unique submission ID'
  );

  const savedSubmissions = await prisma.submission.findMany({
    where: {
      id: {
        in: [first.submissionId, second.submissionId],
      },
    },
  });

  assert.equal(savedSubmissions.length, 2);

  assert.ok(
    savedSubmissions.every(
      (submission) =>
        submission.teamId === team.id &&
        submission.problemId === problem.id &&
        submission.status === 'PENDING'
    )
  );

  console.log('PASS: Submission IDs are unique and match database records.');

  console.log('\nTesting submission limit...');
  const third = await reserveSubmission(request);
  assert.equal(third.success, false);
  console.log('Third:', third);

  const submissions = await prisma.submission.findMany({
    where: {
      teamId: team.id,
      problemId: problem.id,
    },
  });

  assert.equal(submissions.length, 2);
  assert.ok(submissions.every((s) => s.status === 'PENDING'));

  console.log('\nPASS: Exactly two attempts were reserved.');
  // Remove the first two submissions so we can test concurrency
  // with two available submission slots.
  await prisma.submission.deleteMany({
    where: {
      teamId: team.id,
      problemId: problem.id,
    },
  });

  console.log('\nTesting 10 simultaneous reservation requests...');

  const concurrentResults = await Promise.all(
    Array.from({ length: 10 }, () => reserveSubmission(request))
  );

  const accepted = concurrentResults.filter((result) => result.success);
  const rejected = concurrentResults.filter((result) => !result.success);

  const finalCount = await prisma.submission.count({
    where: {
      teamId: team.id,
      problemId: problem.id,
    },
  });

  console.log('Accepted:', accepted.length);
  console.log('Rejected:', rejected.length);
  console.log('Final submission count:', finalCount);

  assert.equal(accepted.length, 2);
  assert.equal(rejected.length, 8);
  assert.equal(finalCount, 2);

  console.log('\nPASS: Concurrent requests respected the submission limit.');
} catch (error) {
  console.error('\nTEST FAILED:', error);
  process.exitCode = 1;
} finally {
  if (testUserId !== null) {
    // The test user's dependent groups, teams, problems and
    // submissions must be deleted before removing the user.
    const groups = await prisma.group.findMany({
      where: { adminId: testUserId },
      select: { id: true },
    });

    for (const group of groups) {
      await prisma.group.delete({ where: { id: group.id } });
    }

    await prisma.user.delete({ where: { id: testUserId } });

    console.log('Temporary test records removed.');
  }

  await prisma.$disconnect();
}
