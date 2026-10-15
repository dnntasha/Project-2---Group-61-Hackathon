import { prisma } from '../lib/prisma.js';

/**
 * Checks whether a team may submit a solution to a problem.
 *
 * This function only validates eligibility.
 * It does not reserve an attempt or execute code.
 */
export async function checkSubmissionEligibility({
  userId,
  teamId,
  problemId,
}) {
  if (
    !Number.isInteger(teamId) ||
    teamId <= 0 ||
    !Number.isInteger(problemId) ||
    problemId <= 0
  ) {
    return {
      success: false,
      status: 400,
      error: 'Valid team and problem IDs are required.',
    };
  }

  const team = await prisma.team.findUnique({
    where: { id: teamId },
  });

  if (!team) {
    return {
      success: false,
      status: 404,
      error: 'Team not found.',
    };
  }

  if (team.leaderId !== userId) {
    return {
      success: false,
      status: 403,
      error: 'Only the team leader may submit a solution.',
    };
  }

  const problem = await prisma.problem.findUnique({
    where: { id: problemId },
    include: { testCases: true },
  });

  if (!problem || problem.groupId !== team.groupId) {
    return {
      success: false,
      status: 404,
      error: 'Problem not found for this team.',
    };
  }

  if (problem.testCases.length === 0) {
    return {
      success: false,
      status: 409,
      error: 'This problem has no configured test cases.',
    };
  }

  return {
    success: true,
    status: 200,
    teamId: team.id,
    problemId: problem.id,
    submissionLimit: problem.submissionLimit,
  };
}

/**
 * Atomically reserves one submission attempt.
 *
 * All eligibility and submission-limit checks happen inside
 * a single SQLite INSERT statement.
 *
 * A FAILED submission still counts as an attempt.
 */
export async function reserveSubmission({ userId, teamId, problemId }) {
  if (
    !Number.isInteger(userId) ||
    userId <= 0 ||
    !Number.isInteger(teamId) ||
    teamId <= 0 ||
    !Number.isInteger(problemId) ||
    problemId <= 0
  ) {
    return {
      success: false,
      status: 400,
      error: 'Valid user, team and problem IDs are required.',
    };
  }

  const inserted = await prisma.$queryRaw`
    INSERT INTO "Submission" ("teamId", "problemId", "status")
    SELECT t."id", p."id", 'PENDING'
    FROM "Team" AS t
    JOIN "Problem" AS p ON p."groupId" = t."groupId"
    WHERE t."id" = ${teamId}
      AND t."leaderId" = ${userId}
      AND p."id" = ${problemId}
      AND EXISTS (
        SELECT 1
        FROM "TestCase" AS tc
        WHERE tc."problemId" = p."id"
      )
      AND (
        p."submissionLimit" = 0
        OR (
          SELECT COUNT(*)
          FROM "Submission" AS s
          WHERE s."teamId" = t."id"
            AND s."problemId" = p."id"
        ) < p."submissionLimit"
      )
    RETURNING "id"
  `;

  if (inserted.length === 0) {
    return {
      success: false,
      status: 409,
      error:
        'Submission could not be reserved. Check team leadership, problem eligibility and remaining attempts.',
    };
  }

  return {
    success: true,
    status: 201,
    submissionId: inserted[0].id,
    message: 'Submission attempt reserved successfully.',
  };
}
