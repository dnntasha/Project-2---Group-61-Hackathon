import { Router } from 'express';

import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { hasStarted } from '../middleware/groups.js';

const router = Router();

// Create a team
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { name, groupId } = req.body;

    if (!name || !groupId) {
      return res.status(400).json({
        error: 'Team name and group are required.',
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

    if (hasStarted(group)) {
      return res.status(409).json({
        error:
          'The event has already started, so teams can no longer be changed.',
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

    const isAdmin = group.adminId === req.user.id;

    if (!membership && !isAdmin) {
      return res.status(403).json({
        error: 'You must be a member of the group to create a team.',
      });
    }

    // A user should not already be on another team in this group
    const currentTeam = await prisma.teamMember.findFirst({
      where: {
        userId: req.user.id,
        team: {
          groupId,
        },
      },
    });

    if (currentTeam) {
      return res.status(409).json({
        error: 'You are already part of a team in this group.',
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

// Invite a user to a team
router.post('/:teamId/invites', requireAuth, async (req, res, next) => {
  try {
    const teamId = Number(req.params.teamId);
    const { userId } = req.body;

    if (!Number.isInteger(teamId)) {
      return res.status(400).json({
        error: 'Invalid team.',
      });
    }

    if (!Number.isInteger(userId)) {
      return res.status(400).json({
        error: 'A valid user must be selected.',
      });
    }

    const team = await prisma.team.findUnique({
      where: {
        id: teamId,
      },
      include: {
        members: true,
        invites: true,
        group: true,
      },
    });

    if (!team) {
      return res.status(404).json({
        error: 'Team not found.',
      });
    }

    if (hasStarted(team.group)) {
      return res.status(409).json({
        error: 'The event has already started, so team invitations are closed.',
      });
    }

    if (team.leaderId !== req.user.id) {
      return res.status(403).json({
        error: 'Only the team leader can invite users.',
      });
    }

    const invitedUser = await prisma.user.findUnique({
      where: {
        id: userId,
      },
    });

    if (!invitedUser) {
      return res.status(404).json({
        error: 'User not found.',
      });
    }

    const groupMember = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: team.groupId,
          userId,
        },
      },
    });

    if (!groupMember) {
      return res.status(400).json({
        error: 'The user must belong to the same group.',
      });
    }

    const alreadyMember = await prisma.teamMember.findUnique({
      where: {
        teamId_userId: {
          teamId,
          userId,
        },
      },
    });

    if (alreadyMember) {
      return res.status(409).json({
        error: 'This user is already a member of the team.',
      });
    }

    // Check if the user is already in another team in this group
    const otherTeam = await prisma.teamMember.findFirst({
      where: {
        userId,
        team: {
          groupId: team.groupId,
        },
      },
    });

    if (otherTeam) {
      return res.status(409).json({
        error: 'This user is already part of another team in the group.',
      });
    }

    const existingInvite = await prisma.teamInvite.findUnique({
      where: {
        teamId_userId: {
          teamId,
          userId,
        },
      },
    });

    if (existingInvite) {
      return res.status(409).json({
        error: 'This user already has an invitation to the team.',
      });
    }

    // Pending invites count towards the maximum team size
    if (team.members.length + team.invites.length >= team.group.maxTeamSize) {
      return res.status(400).json({
        error: 'The team has reached its maximum size.',
      });
    }

    const invite = await prisma.teamInvite.create({
      data: {
        teamId,
        userId,
      },
    });

    return res.status(201).json(invite);
  } catch (err) {
    next(err);
  }
});

// Accept a team invite
router.post(
  '/invites/:inviteId/accept',
  requireAuth,
  async (req, res, next) => {
    try {
      const inviteId = Number(req.params.inviteId);

      if (!Number.isInteger(inviteId)) {
        return res.status(400).json({
          error: 'Invalid invitation.',
        });
      }

      const invite = await prisma.teamInvite.findUnique({
        where: {
          id: inviteId,
        },
        include: {
          team: {
            include: {
              group: true,
              members: true,
            },
          },
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

      // Do not allow team changes once the hackathon has started.
      if (hasStarted(invite.team.group)) {
        return res.status(409).json({
          error: 'The event has already started, so you cannot join this team.',
        });
      }

      // Prevent joining multiple teams in one group
      const existingMembership = await prisma.teamMember.findFirst({
        where: {
          userId: req.user.id,
          team: {
            groupId: invite.team.groupId,
          },
        },
      });

      if (existingMembership) {
        return res.status(409).json({
          error: 'You are already part of a team in this group.',
        });
      }

      if (invite.team.members.length >= invite.team.group.maxTeamSize) {
        return res.status(400).json({
          error: 'The team is already full.',
        });
      }

      const membership = await prisma.$transaction(async (tx) => {
        const newMember = await tx.teamMember.create({
          data: {
            teamId: invite.teamId,
            userId: req.user.id,
          },
        });

        await tx.teamInvite.delete({
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

// Decline a team invite
router.post(
  '/invites/:inviteId/decline',
  requireAuth,
  async (req, res, next) => {
    try {
      const inviteId = Number(req.params.inviteId);

      if (!Number.isInteger(inviteId)) {
        return res.status(400).json({
          error: 'Invalid invitation.',
        });
      }

      const invite = await prisma.teamInvite.findUnique({
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

      await prisma.teamInvite.delete({
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

// Leave a team
router.post('/:teamId/leave', requireAuth, async (req, res, next) => {
  try {
    const teamId = Number(req.params.teamId);

    if (!Number.isInteger(teamId)) {
      return res.status(400).json({
        error: 'Invalid team.',
      });
    }

    const team = await prisma.team.findUnique({
      where: {
        id: teamId,
      },
      include: {
        group: true,
        members: {
          orderBy: {
            joinedAt: 'asc',
          },
        },
      },
    });

    if (!team) {
      return res.status(404).json({
        error: 'Team not found.',
      });
    }

    // Team membership may not change after the event has started.
    if (hasStarted(team.group)) {
      return res.status(409).json({
        error: 'The event has already started, so you cannot leave your team.',
      });
    }

    const membership = team.members.find(
      (member) => member.userId === req.user.id
    );

    if (!membership) {
      return res.status(403).json({
        error: 'You are not a member of this team.',
      });
    }

    // If this is the last member, remove the whole team
    if (team.members.length === 1) {
      await prisma.team.delete({
        where: {
          id: teamId,
        },
      });

      return res.json({
        message: 'You left the team. The empty team was deleted.',
      });
    }

    // If the leader leaves, transfer leadership to the
    // longest-standing remaining team member.
    if (team.leaderId === req.user.id) {
      const newLeader = team.members.find(
        (member) => member.userId !== req.user.id
      );

      await prisma.$transaction([
        prisma.team.update({
          where: {
            id: teamId,
          },
          data: {
            leaderId: newLeader.userId,
          },
        }),

        prisma.teamMember.delete({
          where: {
            teamId_userId: {
              teamId,
              userId: req.user.id,
            },
          },
        }),
      ]);

      return res.json({
        message: 'You left the team and leadership was transferred.',
        newLeaderId: newLeader.userId,
      });
    }

    await prisma.teamMember.delete({
      where: {
        teamId_userId: {
          teamId,
          userId: req.user.id,
        },
      },
    });

    return res.json({
      message: 'You left the team.',
    });
  } catch (err) {
    next(err);
  }
});

export default router;
