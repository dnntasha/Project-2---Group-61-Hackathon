import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  buildProblemLeaderboard,
  buildFinalLeaderboard,
} from '../leaderboard/leaderboardService.js';

const router = Router();

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
