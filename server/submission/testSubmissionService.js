import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { processSubmission } from './submissionService.js';

let testUserId = null;

try {
  const user = await prisma.user.create({
    data: {
      username: `service-test-${randomUUID()}`,
      passwordHash: 'TEST_ONLY_NOT_A_REAL_PASSWORD',
    },
  });

  testUserId = user.id;

  const group = await prisma.group.create({
    data: {
      name: `Service Test Group ${randomUUID()}`,
      adminId: user.id,
      maxTeamSize: 5,
    },
  });

  const team = await prisma.team.create({
    data: {
      name: 'Service Test Team',
      groupId: group.id,
      leaderId: user.id,
    },
  });

  const problem = await prisma.problem.create({
    data: {
      groupId: group.id,
      title: 'Service Test Problem',
      description: 'Temporary integration test problem.',
      submissionLimit: 2,
      testCases: {
        create: [
          {
            input: '2\n',
            expectedOutput: '4\n',
            timeLimit: 5000,
            hidden: false,
          },
          {
            input: '3\n',
            expectedOutput: '6\n',
            timeLimit: 5000,
            hidden: true,
          },
        ],
      },
    },
  });

  const codebase = {
    type: 'directory',
    name: 'root',
    children: [
      {
        type: 'file',
        name: 'main.py',
        content: [
          'def main():',
          '    number = int(input())',
          '    print(number * 2)',
          '',
          'if __name__ == "__main__":',
          '    main()',
          '',
        ].join('\n'),
      },
    ],
  };

  const request = {
    userId: user.id,
    teamId: team.id,
    problemId: problem.id,
    codebase,
  };

  console.log('\nTEST 1: Complete submission and grading');

  const first = await processSubmission(request);

  assert.equal(first.success, true);
  assert.equal(first.submissionStatus, 'COMPLETED');
  assert.equal(first.score.P, 100);
  assert.equal(first.evaluation.passedTests, 2);
  assert.equal(first.evaluation.totalTests, 2);
  assert.ok(first.score.T >= 0);

  const saved = await prisma.submission.findUnique({
    where: { id: first.submissionId },
  });

  assert.equal(saved.status, 'COMPLETED');
  assert.equal(saved.scoreP, 100);
  assert.equal(saved.scoreT, first.score.T);

  console.log('PASS: Docker grading and database persistence work.');

  console.log('\nTEST 2: Reject unauthorized submission');

  const unauthorized = await processSubmission({
    ...request,
    userId: user.id + 999999,
  });

  assert.equal(unauthorized.success, false);
  assert.equal(unauthorized.status, 403);

  console.log('PASS: Non-leader submission rejected.');

  console.log('\nTEST 3: Reject invalid codebase');

  const invalid = await processSubmission({
    ...request,
    codebase: null,
  });

  assert.equal(invalid.success, false);
  assert.equal(invalid.status, 400);

  console.log('PASS: Invalid codebase rejected.');

  console.log('\nTEST 4: Complete second submission');

  const second = await processSubmission(request);

  assert.equal(second.success, true);
  assert.equal(second.submissionStatus, 'COMPLETED');

  console.log('PASS: Second attempt completed.');

  console.log('\nTEST 5: Enforce submission limit');

  const third = await processSubmission(request);

  assert.equal(third.success, false);
  assert.equal(third.status, 409);

  const count = await prisma.submission.count({
    where: {
      teamId: team.id,
      problemId: problem.id,
    },
  });

  assert.equal(count, 2);

  console.log('PASS: Submission limit enforced.');

  console.log('\nALL SUBMISSION SERVICE TESTS PASSED!');
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
    } catch (error) {
      console.error('Cleanup failed:', error);
      process.exitCode = 1;
    }
  }

  await prisma.$disconnect();
}
