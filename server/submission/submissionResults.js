import { prisma } from '../lib/prisma.js';

/**
 * Saves grading scores for a pending submission.
 *
 * A submission can only transition from PENDING to COMPLETED once.
 */
export async function completeSubmission({ submissionId, scoreP, scoreT }) {
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

  const result = await prisma.submission.updateMany({
    where: {
      id: submissionId,
      status: 'PENDING',
    },
    data: {
      status: 'COMPLETED',
      scoreP,
      scoreT,
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
    score: {
      P: scoreP,
      T: scoreT,
    },
  };
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
