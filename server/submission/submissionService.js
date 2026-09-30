import { evaluateCodebase } from '../evaluation/codebaseEvaluator.js';

export async function processSubmission({
  codebase,
  testCases,
  isLeader,
  submissionsUsed = 0,
  submissionLimit,
}) {
  if (!isLeader) {
    return {
      success: false,
      status: 403,
      error: 'Only the team leader may submit a solution.',
    };
  }

  if (Number.isInteger(submissionLimit) && submissionsUsed >= submissionLimit) {
    return {
      success: false,
      status: 429,
      error: 'Submission limit reached.',
    };
  }

  if (!codebase || codebase.type !== 'directory') {
    return {
      success: false,
      status: 400,
      error: 'A valid codebase is required.',
    };
  }

  if (!Array.isArray(testCases) || testCases.length === 0) {
    return {
      success: false,
      status: 400,
      error: 'At least one test case is required.',
    };
  }

  const evaluation = await evaluateCodebase(codebase, testCases);

  return {
    success: true,
    status: 200,
    evaluation,
    score: {
      P: evaluation.passPercentage,
      T: evaluation.totalPassedRuntimeMs,
    },
  };
}
