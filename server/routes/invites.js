import { Router } from 'express';

import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// GET /api/invites/count
// How many invitations are waiting for the signed-in user, split by kind.
// The navbar badge shows `total`. Group and team invites live in different
// tables, so we count each and add them up.
router.get('/count', requireAuth, async (req, res, next) => {
  try {
    // Both counts are independent, so run them at the same time
    const [group, team] = await Promise.all([
      prisma.groupInvite.count({ where: { userId: req.user.id } }),
      prisma.teamInvite.count({ where: { userId: req.user.id } }),
    ]);

    return res.json({ group, team, total: group + team });
  } catch (err) {
    next(err);
  }
});

export default router;
