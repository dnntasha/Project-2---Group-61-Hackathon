// Submission timeline (spec section 11): every submission a team made for a
// problem, newest first, with the result of each test case.
// Mounted at /api/teams/:teamId/submissions (before the teams router).
import { Router } from 'express';

import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { formatTestResult } from '../evaluation/codebaseEvaluator.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);

const wrap = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

// Shapes one stored submission like a live SUBMISSION_RESULT, so the client
// can show either in the same ResponseArea / SubmissionTimeline components.
// formatTestResult applies the hidden-test rules again: hidden tests only
// ever show whether they passed, the reason and the runtime.
function toClient(submission) {
  const results = submission.results.map((row) =>
    formatTestResult(row.testCase, {
      passed: row.passed,
      runtimeMs: row.runtimeMs,
      reason: row.reason,
      stdout: row.actualOutput ?? '',
    })
  );
  const passedTests = results.filter((result) => result.passed).length;
  const completed = submission.status === 'COMPLETED';

  return {
    id: submission.id,
    problemId: submission.problemId,
    status: submission.status,
    timestamp: submission.createdAt,
    passed: completed && results.length > 0 && passedTests === results.length,
    passedTests,
    totalTests: results.length,
    P: submission.scoreP,
    T: submission.scoreT,
    evaluation: completed
      ? {
          passed: results.length > 0 && passedTests === results.length,
          reason: submission.reason,
          passedTests,
          totalTests: results.length,
          passPercentage: submission.scoreP,
          totalPassedRuntimeMs: submission.scoreT,
          results,
        }
      : null,
    error:
      submission.status === 'FAILED'
        ? 'Grading could not be completed. This attempt was not counted.'
        : submission.status === 'PENDING'
          ? 'Still being graded…'
          : undefined,
  };
}

// GET /api/teams/:teamId/submissions?problemId=<id>
// Team members (and the group admin) can read a team's timeline.
router.get(
  '/',
  wrap(async (req, res) => {
    const teamId = Number(req.params.teamId);
    const problemId = Number(req.query.problemId);

    if (!Number.isInteger(teamId) || !Number.isInteger(problemId)) {
      return res.status(400).json({ error: 'Invalid team or problem.' });
    }

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: {
        group: { select: { adminId: true } },
        members: { where: { userId: req.user.id }, select: { id: true } },
      },
    });

    const allowed =
      team && (team.members.length > 0 || team.group.adminId === req.user.id);
    if (!allowed) {
      return res.status(404).json({ error: 'Team not found.' });
    }

    const problem = await prisma.problem.findUnique({
      where: { id: problemId },
      select: { groupId: true, submissionLimit: true },
    });
    if (!problem || problem.groupId !== team.groupId) {
      return res.status(404).json({ error: 'Problem not found.' });
    }

    const submissions = await prisma.submission.findMany({
      where: { teamId, problemId },
      orderBy: { id: 'desc' },
      include: {
        results: {
          orderBy: { testCaseId: 'asc' },
          include: { testCase: true },
        },
      },
    });

    return res.json({
      submissions: submissions.map(toClient),
      // FAILED attempts (grading errors) don't use up the limit
      used: submissions.filter((s) => s.status !== 'FAILED').length,
      submissionLimit: problem.submissionLimit,
    });
  })
);

export default router;
