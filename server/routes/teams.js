import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const prisma = new PrismaClient();

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { name, groupId } = req.body;

    if (!name || !groupId) {
      return res.status(400).json({
        error: 'Team name and group are required.',
      });
    }

    const membership = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId: req.user.id,
        },
      },
    });

    if (!membership) {
      return res.status(403).json({
        error: 'You must be a member of the group to create a team.',
      });
    }

    const existingTeam = await prisma.team.findUnique({
      where: {
        groupId_name: {
          groupId,
          name,
        },
      },
    });

    if (existingTeam) {
      return res.status(409).json({
        error: 'A team with this name already exists in the group.',
      });
    }

    const team = await prisma.team.create({
      data: {
        name,
        groupId,
        leaderId: req.user.id,
        members: {
          create: {
            userId: req.user.id,
          },
        },
      },
      include: {
        members: true,
      },
    });

    return res.status(201).json(team);
  } catch (err) {
    next(err);
  }
});

export default router;
