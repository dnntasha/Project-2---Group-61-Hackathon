import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireGroupMember } from '../middleware/groups.js';
import { prisma } from '../lib/prisma.js';
import {
  buildProblemLeaderboard,
  buildFinalLeaderboard,
} from '../leaderboard/leaderboardService.js';

const router = Router();

/*
 * Returns true if the candidate submission is better.
 * Higher P is better, then lower T.
 */
function isBetterSubmission(candidate, current) {
  if (!current) return true;

  const candidateP = candidate.scoreP ?? 0;
  const currentP = current.scoreP ?? 0;

  const candidateT = candidate.scoreT ?? 0;
  const currentT = current.scoreT ?? 0;

  if (candidateP !== currentP) {
    return candidateP > currentP;
  }

  return candidateT < currentT;
}

/*
 * Keeps the best completed submission for each team/problem pair.
 */
function getBestSubmissions(submissions) {
  const best = new Map();

  for (const submission of submissions) {
    const key = `${submission.teamId}:${submission.problemId}`;
    const current = best.get(key);

    if (isBetterSubmission(submission, current)) {
      best.set(key, submission);
    }
  }

  return [...best.values()];
}

/*
 * GET /api/leaderboards/groups/:groupId/problems/:problemId
 *
 * Problem-specific leaderboard.
 */
router.get(
  '/groups/:groupId/problems/:problemId',
  requireAuth,
  requireGroupMember,
  async (req, res, next) => {
    try {
      const groupId = Number(req.params.groupId);
      const problemId = Number(req.params.problemId);

      if (!Number.isInteger(groupId) || !Number.isInteger(problemId)) {
        return res.status(400).json({
          error: 'Invalid group or problem ID.',
        });
      }

      const problem = await prisma.problem.findFirst({
        where: {
          id: problemId,
          groupId,
        },
      });

      if (!problem) {
        return res.status(404).json({
          error: 'Problem not found in this group.',
        });
      }

      const submissions = await prisma.submission.findMany({
        where: {
          problemId,
          status: 'COMPLETED',
          team: {
            groupId,
          },
        },

        select: {
          id: true,
          teamId: true,
          problemId: true,
          scoreP: true,
          scoreT: true,
          createdAt: true,

          team: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      const bestSubmissions = getBestSubmissions(submissions);

      const scores = bestSubmissions.map((submission) => ({
        teamId: submission.teamId,
        teamName: submission.team.name,
        P: submission.scoreP ?? 0,
        T: submission.scoreT ?? 0,
      }));

      const leaderboard = buildProblemLeaderboard(scores);

      return res.json({
        groupId,
        problemId,
        submittingTeams: leaderboard.length,
        leaderboard,
      });
    } catch (err) {
      next(err);
    }
  }
);

/*
 * GET /api/leaderboards/groups/:groupId/final
 *
 * Final leaderboard. This is only available after the event ends.
 */
router.get(
  '/groups/:groupId/final',
  requireAuth,
  requireGroupMember,
  async (req, res, next) => {
    try {
      const groupId = Number(req.params.groupId);

      if (!Number.isInteger(groupId)) {
        return res.status(400).json({
          error: 'Invalid group ID.',
        });
      }

      const group = await prisma.group.findUnique({
        where: {
          id: groupId,
        },

        select: {
          id: true,
          name: true,
          topK: true,
          startedAt: true,
          durationMin: true,

          teams: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      if (!group) {
        return res.status(404).json({
          error: 'Group not found.',
        });
      }

      // Final rankings are only available once the event has finished.
      if (!group.startedAt) {
        return res.status(409).json({
          error:
            'The final leaderboard is only available after the event ends.',
        });
      }

      const endsAt =
        new Date(group.startedAt).getTime() + group.durationMin * 60 * 1000;

      if (Date.now() < endsAt) {
        return res.status(409).json({
          error:
            'The final leaderboard is only available after the event ends.',
        });
      }

      const submissions = await prisma.submission.findMany({
        where: {
          status: 'COMPLETED',

          team: {
            groupId,
          },
        },

        select: {
          id: true,
          teamId: true,
          problemId: true,
          scoreP: true,
          scoreT: true,
          createdAt: true,

          team: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      // Select the best submission for each team/problem pair.
      const bestSubmissions = getBestSubmissions(submissions);

      // Group submissions by problem.
      const submissionsByProblem = new Map();

      for (const submission of bestSubmissions) {
        if (!submissionsByProblem.has(submission.problemId)) {
          submissionsByProblem.set(submission.problemId, []);
        }

        submissionsByProblem.get(submission.problemId).push(submission);
      }

      // Build the leaderboard for every problem.
      const problemLeaderboards = new Map();

      for (const [problemId, problemSubmissions] of submissionsByProblem) {
        const scores = problemSubmissions.map((submission) => ({
          teamId: submission.teamId,
          teamName: submission.team.name,
          P: submission.scoreP ?? 0,
          T: submission.scoreT ?? 0,
        }));

        const leaderboard = buildProblemLeaderboard(scores);

        problemLeaderboards.set(problemId, leaderboard);
      }

      // Convert the problem rankings into the format used by
      // buildFinalLeaderboard().
      const teamsForFinalLeaderboard = group.teams.map((team) => {
        const problems = [];

        for (const [problemId, leaderboard] of problemLeaderboards) {
          const teamResult = leaderboard.find(
            (entry) => entry.teamId === team.id
          );

          if (!teamResult) {
            continue;
          }

          problems.push({
            problemId,
            position: teamResult.position,
            submittingTeams: leaderboard.length,
            P: teamResult.P,
            T: teamResult.T,
          });
        }

        return {
          teamId: team.id,
          teamName: team.name,
          problems,
        };
      });

      const leaderboard = buildFinalLeaderboard(
        teamsForFinalLeaderboard,
        group.topK
      );

      return res.json({
        groupId: group.id,
        groupName: group.name,
        topK: group.topK,
        leaderboard,
      });
    } catch (err) {
      next(err);
    }
  }
);

/*
 * Old manual routes kept so existing tests/code continue to work.
 */
router.post('/problem', requireAuth, (req, res) => {
  const { scores } = req.body;

  if (!Array.isArray(scores)) {
    return res.status(400).json({
      error: 'Scores must be provided.',
    });
  }

  const leaderboard = buildProblemLeaderboard(scores);

  return res.json(leaderboard);
});

router.post('/final', requireAuth, (req, res) => {
  const { teams, k } = req.body;

  if (!Array.isArray(teams) || !Number.isInteger(k) || k < 1) {
    return res.status(400).json({
      error: 'Teams and a valid k value are required.',
    });
  }

  const leaderboard = buildFinalLeaderboard(teams, k);

  return res.json(leaderboard);
});

export default router;
