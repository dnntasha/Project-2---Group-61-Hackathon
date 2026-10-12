import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const prisma = new PrismaClient();

// Send a group invite
router.post('/:groupId/invites', requireAuth, async (req, res, next) => {
  try {
    const groupId = Number(req.params.groupId);
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        error: 'A user must be selected.',
      });
    }

    const group = await prisma.group.findUnique({
      where: {
        id: groupId,
      },
    });

    if (!group) {
      return res.status(404).json({
        error: 'Group not found.',
      });
    }

    if (group.adminId !== req.user.id) {
      return res.status(403).json({
        error: 'Only the group administrator can send invitations.',
      });
    }

    const existingMember = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId,
        },
      },
    });

    if (existingMember) {
      return res.status(409).json({
        error: 'This user is already a member of the group.',
      });
    }

    const existingInvite = await prisma.groupInvite.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId,
        },
      },
    });

    if (existingInvite) {
      return res.status(409).json({
        error: 'This user already has an invitation to the group.',
      });
    }

    const invite = await prisma.groupInvite.create({
      data: {
        groupId,
        userId,
      },
    });

    return res.status(201).json(invite);
  } catch (err) {
    next(err);
  }
});

// Accept group invite
router.post(
  '/invites/:inviteId/accept',
  requireAuth,
  async (req, res, next) => {
    try {
      const inviteId = Number(req.params.inviteId);

      const invite = await prisma.groupInvite.findUnique({
        where: {
          id: inviteId,
        },
      });

      if (!invite) {
        return res.status(404).json({
          error: 'Invite not found.',
        });
      }

      if (invite.userId !== req.user.id) {
        return res.status(403).json({
          error: 'This invitation does not belong to you.',
        });
      }

      const membership = await prisma.$transaction(async (tx) => {
        const newMember = await tx.groupMember.create({
          data: {
            groupId: invite.groupId,
            userId: req.user.id,
          },
        });

        await tx.groupInvite.delete({
          where: {
            id: inviteId,
          },
        });

        return newMember;
      });

      return res.status(200).json(membership);
    } catch (err) {
      next(err);
    }
  }
);

// Decline group invite
router.post(
  '/invites/:inviteId/decline',
  requireAuth,
  async (req, res, next) => {
    try {
      const inviteId = Number(req.params.inviteId);

      const invite = await prisma.groupInvite.findUnique({
        where: {
          id: inviteId,
        },
      });

      if (!invite) {
        return res.status(404).json({
          error: 'Invite not found.',
        });
      }

      if (invite.userId !== req.user.id) {
        return res.status(403).json({
          error: 'This invitation does not belong to you.',
        });
      }

      await prisma.groupInvite.delete({
        where: {
          id: inviteId,
        },
      });

      return res.json({
        message: 'Invitation declined.',
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
