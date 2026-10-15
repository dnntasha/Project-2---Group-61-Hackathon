import { prisma } from '../lib/prisma.js';
import {
  evaluateCodebase,
  validateCodebaseTree,
} from '../evaluation/codebaseEvaluator.js';
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

  // Validate the whole tree up front so bad input doesn't use up an attempt
  const treeError = validateCodebaseTree(codebase);
  if (treeError) {
    return {
      success: false,
      status: 400,
      error: treeError,
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
      const failure = await failSubmission({ submissionId });
      if (!failure.success) {
        console.error(
          `Unable to mark submission ${submissionId} as failed:`,
          failure.error
        );
      }
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
