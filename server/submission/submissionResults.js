import { prisma } from '../lib/prisma.js';

/**
 * Saves grading scores for a pending submission.
 *
 * A submission can only transition from PENDING to COMPLETED once.
 */
export async function completeSubmission({
  submissionId,
  scoreP,
  scoreT,
  results = [],
  reason = null,
}) {
  if (
    !Number.isInteger(submissionId) ||
    submissionId <= 0 ||
    !Number.isFinite(scoreP) ||
    scoreP < 0 ||
    scoreP > 100 ||
    !Number.isFinite(scoreT) ||
    scoreT < 0
  ) {
    return {
      success: false,
      status: 400,
      error: 'Invalid submission ID or grading scores.',
    };
  }

  // Status and results are written together, so the timeline never shows a
  // completed submission without its test results
  const completed = await prisma.$transaction(async (tx) => {
    const result = await tx.submission.updateMany({
      where: {
        id: submissionId,
        status: 'PENDING',
      },
      data: {
        status: 'COMPLETED',
        scoreP,
        scoreT,
        reason,
      },
    });

    if (result.count === 0) return false;

    const rows = results
      .filter((test) => Number.isInteger(test.testCaseId))
      .map((test) => ({
        submissionId,
        testCaseId: test.testCaseId,
        passed: Boolean(test.passed),
        runtimeMs: Number.isFinite(test.runtimeMs) ? test.runtimeMs : 0,
        reason: test.reason ?? null,
        // Only present for failed visible tests (formatTestResult hides it
        // for hidden ones), so hidden outputs are never stored
        actualOutput: test.actualOutput ?? null,
      }));
    if (rows.length > 0) {
      await tx.submissionResult.createMany({ data: rows });
    }
    return true;
  });

  if (!completed) {
    return {
      success: false,
      status: 409,
      error: 'Submission not found or already finalized.',
    };
  }

  return {
    success: true,
    status: 200,
    submissionId,
    score: {
      P: scoreP,
      T: scoreT,
    },
  };
}

/**
 * Grading runs inside the server process, so any submission still PENDING
 * when the server starts was interrupted (e.g. by a restart) and will never
 * finish. Marks those as FAILED so they don't count as attempts.
 */
export async function failInterruptedSubmissions() {
  const result = await prisma.submission.updateMany({
    where: { status: 'PENDING' },
    data: { status: 'FAILED' },
  });
  return result.count;
}

/**
 * Marks a pending submission as failed if grading cannot complete.
 */
export async function failSubmission({ submissionId }) {
  if (!Number.isInteger(submissionId) || submissionId <= 0) {
    return {
      success: false,
      status: 400,
      error: 'Invalid submission ID.',
    };
  }

  const result = await prisma.submission.updateMany({
    where: {
      id: submissionId,
      status: 'PENDING',
    },
    data: {
      status: 'FAILED',
    },
  });

  if (result.count === 0) {
    return {
      success: false,
      status: 409,
      error: 'Submission not found or already finalized.',
    };
  }

  return {
    success: true,
    status: 200,
    submissionId,
  };
}
