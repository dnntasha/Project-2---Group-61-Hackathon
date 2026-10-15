import { prisma } from '../lib/prisma.js';
import { evaluateCodebase } from '../evaluation/codebaseEvaluator.js';
import {
  checkSubmissionEligibility,
  reserveSubmission,
} from './submissionReservation.js';
import { completeSubmission, failSubmission } from './submissionResults.js';

/**
 * Processes a submission using authenticated database state.
 *
 * P = percentage of tests passed.
 * T = total runtime in milliseconds for passed tests.
 *
 * Incorrect answers are completed grading attempts.
 * FAILED is reserved for grading infrastructure failures.
 */
export async function processSubmission({
  userId,
  teamId,
  problemId,
  codebase,
}) {
  if (!Number.isInteger(userId) || userId <= 0) {
    return {
      success: false,
      status: 401,
      error: 'Authentication is required.',
    };
  }

  if (
    !codebase ||
    codebase.type !== 'directory' ||
    !Array.isArray(codebase.children)
  ) {
    return {
      success: false,
      status: 400,
      error: 'A valid codebase directory is required.',
    };
  }

  // Check eligibility before reserving an attempt.
  const eligibility = await checkSubmissionEligibility({
    userId,
    teamId,
    problemId,
  });

  if (!eligibility.success) {
    return eligibility;
  }

  // Atomically reserve one attempt.
  const reservation = await reserveSubmission({
    userId,
    teamId,
    problemId,
  });

  if (!reservation.success) {
    return reservation;
  }

  const submissionId = reservation.submissionId;

  try {
    // Never accept grading test cases from the frontend.
    const testCases = await prisma.testCase.findMany({
      where: { problemId },
      orderBy: { id: 'asc' },
    });

    if (testCases.length === 0) {
      throw new Error('No test cases available for grading.');
    }

    const evaluation = await evaluateCodebase(codebase, testCases);

    const completion = await completeSubmission({
      submissionId,
      scoreP: evaluation.passPercentage,
      scoreT: evaluation.totalPassedRuntimeMs,
    });

    if (!completion.success) {
      throw new Error('Unable to save submission results.');
    }

    return {
      success: true,
      status: 200,
      submissionId,
      submissionStatus: 'COMPLETED',
      evaluation,
      score: {
        P: evaluation.passPercentage,
        T: evaluation.totalPassedRuntimeMs,
      },
    };
  } catch (error) {
    console.error(`Submission ${submissionId} failed:`, error);

    try {
      await failSubmission({ submissionId });
    } catch (failureError) {
      console.error(
        `Unable to mark submission ${submissionId} as failed:`,
        failureError
      );
    }

    return {
      success: false,
      status: 500,
      submissionId,
      submissionStatus: 'FAILED',
      error: 'Submission grading could not be completed.',
    };
  }
}
