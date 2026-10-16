import { Router } from 'express';

import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { hasStarted } from '../middleware/groups.js';
import { notifyInvitesChanged } from '../lib/notifier.js';

const router = Router();

const MAX_TEAM_NAME_LENGTH = 40;

// An error the shared error handler turns into this status and message
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Deletes every pending team invitation a user holds in one group (optionally
// keeping one) and returns the leaders of those teams, who should be told.
// Called once the user has a team, so the old invitations stop taking up
// places in other teams.
async function releaseOtherInvites(tx, userId, groupId, keepInviteId) {
  const others = await tx.teamInvite.findMany({
    where: {
      userId,
      team: { groupId },
      ...(keepInviteId === undefined ? {} : { id: { not: keepInviteId } }),
    },
    select: { id: true, team: { select: { leaderId: true } } },
  });

  if (others.length > 0) {
    await tx.teamInvite.deleteMany({
      where: { id: { in: others.map((invite) => invite.id) } },
    });
  }

  return others.map((invite) => invite.team.leaderId);
}

// Get all teams for a group, plus the signed-in user's pending team invites.
router.get('/group/:groupId', requireAuth, async (req, res, next) => {
  try {
    const groupId = Number(req.params.groupId);

    if (!Number.isInteger(groupId)) {
      return res.status(400).json({
        error: 'Invalid group.',
      });
    }

    const group = await prisma.group.findUnique({
      where: {
        id: groupId,
      },
      include: {
        members: {
          where: {
            userId: req.user.id,
          },
          select: {
            id: true,
          },
        },
        teams: {
          include: {
            leader: {
              select: {
                id: true,
                username: true,
              },
            },
            invites: {
              orderBy: {
                createdAt: 'asc',
              },
              include: {
                user: {
                  select: {
                    id: true,
                    username: true,
                  },
                },
              },
            },
            members: {
              orderBy: {
                joinedAt: 'asc',
              },
              include: {
                user: {
                  select: {
                    id: true,
                    username: true,
                  },
                },
              },
            },
          },
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
    });

    if (!group) {
      return res.status(404).json({
        error: 'Group not found.',
      });
    }

    const isGroupMember =
      group.adminId === req.user.id || group.members.length > 0;

    if (!isGroupMember) {
      return res.status(403).json({
        error: 'You do not belong to this group.',
      });
    }

    const pendingInvites = await prisma.teamInvite.findMany({
      where: {
        userId: req.user.id,
        team: {
          groupId,
        },
      },
      include: {
        team: {
          select: {
            id: true,
            name: true,
            leader: {
              select: {
                id: true,
                username: true,
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    let currentTeamId = null;

    const teams = group.teams.map((team) => {
      const members = team.members.map((member) => ({
        id: member.user.id,
        username: member.user.username,
        joinedAt: member.joinedAt,
        isLeader: member.user.id === team.leaderId,
      }));

      const isCurrentUserMember = members.some(
        (member) => member.id === req.user.id
      );

      if (isCurrentUserMember) {
        currentTeamId = team.id;
      }

      return {
        id: team.id,
        name: team.name,
        leaderId: team.leaderId,
        leaderUsername: team.leader.username,
        members,
        // Invitations still waiting for an answer. They take up places in the
        // team, so everyone sees the count; only members see who was invited.
        inviteCount: team.invites.length,
        invites: isCurrentUserMember
          ? team.invites.map((invite) => ({
              id: invite.id,
              userId: invite.user.id,
              username: invite.user.username,
              createdAt: invite.createdAt,
            }))
          : [],
        isCurrentUserMember,
        isCurrentUserLeader: team.leaderId === req.user.id,
      };
    });

    return res.json({
      teams,
      currentTeamId,
      startedAt: group.startedAt,
      maxTeamSize: group.maxTeamSize,
      pendingInvites: pendingInvites.map((invite) => ({
        id: invite.id,
        createdAt: invite.createdAt,
        team: {
          id: invite.team.id,
          name: invite.team.name,
          leaderId: invite.team.leader.id,
          leaderUsername: invite.team.leader.username,
        },
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Create a team
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { name, groupId } = req.body;

    if (
      typeof name !== 'string' ||
      !name.trim() ||
      !Number.isInteger(groupId)
    ) {
      return res.status(400).json({
        error: 'Team name and group are required.',
      });
    }

    if (name.trim().length > MAX_TEAM_NAME_LENGTH) {
      return res.status(400).json({
        error: `Team names can be at most ${MAX_TEAM_NAME_LENGTH} characters.`,
      });
    }

    const trimmedName = name.trim();

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

    // Checked and created in one transaction so two quick requests can't put
    // the same user in two teams of this group
    const { team, releasedLeaderIds } = await prisma.$transaction(
      async (tx) => {
        const currentTeam = await tx.teamMember.findFirst({
          where: {
            userId: req.user.id,
            team: {
              groupId,
            },
          },
        });

        if (currentTeam) {
          throw httpError(409, 'You are already part of a team in this group.');
        }

        const existingTeam = await tx.team.findUnique({
          where: {
            groupId_name: {
              groupId,
              name: trimmedName,
            },
          },
        });

        if (existingTeam) {
          throw httpError(
            409,
            'A team with this name already exists in the group.'
          );
        }

        const created = await tx.team.create({
          data: {
            name: trimmedName,
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

        // Having a team of their own, the creator no longer needs invitations
        // to other teams; leaving them would hold places in those teams
        const releasedLeaderIds = await releaseOtherInvites(
          tx,
          req.user.id,
          groupId
        );

        return { team: created, releasedLeaderIds };
      }
    );

    notifyInvitesChanged(req.user.id, ...releasedLeaderIds);

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

    const isGroupAdmin = team.group.adminId === userId;

    if (!groupMember && !isGroupAdmin) {
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

    if (team.members.length + team.invites.length >= team.group.maxTeamSize) {
      return res.status(400).json({
        error: 'The team has reached its maximum size.',
      });
    }

    // The check above is only a quick, friendly early answer: it was made
    // outside a transaction, so two leaders' requests could both pass it. The
    // invitation is therefore created first (which takes the database's write
    // lock) and the size re-counted, rolling back if the team is now too big.
    const invite = await prisma.$transaction(async (tx) => {
      const created = await tx.teamInvite.create({
        data: {
          teamId,
          userId,
        },
      });

      const [memberCount, inviteCount] = await Promise.all([
        tx.teamMember.count({ where: { teamId } }),
        tx.teamInvite.count({ where: { teamId } }),
      ]);

      if (memberCount + inviteCount > team.group.maxTeamSize) {
        throw httpError(400, 'The team has reached its maximum size.');
      }

      return created;
    });

    // Push to the invitee (badge + invite list) and the leader (other tabs)
    notifyInvitesChanged(userId, team.leaderId);

    return res.status(201).json(invite);
  } catch (err) {
    next(err);
  }
});

// Cancel a pending team invite. Only the team leader can, and only before the
// event starts. This frees the place the invitation was holding.
router.delete(
  '/:teamId/invites/:inviteId',
  requireAuth,
  async (req, res, next) => {
    try {
      const teamId = Number(req.params.teamId);
      const inviteId = Number(req.params.inviteId);

      if (!Number.isInteger(teamId) || !Number.isInteger(inviteId)) {
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
            },
          },
        },
      });

      // An invite id belonging to another team is treated as not found
      if (!invite || invite.teamId !== teamId) {
        return res.status(404).json({
          error: 'Invite not found.',
        });
      }

      if (invite.team.leaderId !== req.user.id) {
        return res.status(403).json({
          error: 'Only the team leader can cancel invitations.',
        });
      }

      if (hasStarted(invite.team.group)) {
        return res.status(409).json({
          error:
            'The event has already started, so teams can no longer be changed.',
        });
      }

      // deleteMany doesn't throw if the invitee accepted or declined meanwhile
      await prisma.teamInvite.deleteMany({
        where: {
          id: inviteId,
        },
      });

      notifyInvitesChanged(invite.userId, req.user.id);

      return res.json({
        message: 'Invitation cancelled.',
      });
    } catch (err) {
      next(err);
    }
  }
);

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

      if (hasStarted(invite.team.group)) {
        return res.status(409).json({
          error: 'The event has already started, so you cannot join this team.',
        });
      }

      // The membership and team-size checks run inside the transaction so
      // concurrent accepts can't overfill a team or double-book a user
      const { membership, releasedLeaderIds } = await prisma.$transaction(
        async (tx) => {
          const existingMembership = await tx.teamMember.findFirst({
            where: {
              userId: req.user.id,
              team: {
                groupId: invite.team.groupId,
              },
            },
          });

          if (existingMembership) {
            throw httpError(
              409,
              'You are already part of a team in this group.'
            );
          }

          const memberCount = await tx.teamMember.count({
            where: { teamId: invite.teamId },
          });

          if (memberCount >= invite.team.group.maxTeamSize) {
            throw httpError(400, 'The team is already full.');
          }

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

          // The user's other invitations in this group can never be used now,
          // and would keep holding places in those teams, so they are removed
          const releasedLeaderIds = await releaseOtherInvites(
            tx,
            req.user.id,
            invite.team.groupId
          );

          return { membership: newMember, releasedLeaderIds };
        }
      );

      // The accepter's other tabs, the leader, everyone already on the team
      // (`invite.team.members` was loaded before the new member joined) and
      // the leaders whose other invitations were just released
      notifyInvitesChanged(
        req.user.id,
        invite.team.leaderId,
        ...invite.team.members.map((member) => member.userId),
        ...releasedLeaderIds
      );

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
        // Needed to find out who leads the team
        include: {
          team: true,
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

      // The decliner's other tabs and the leader (the pending list shrank)
      notifyInvitesChanged(req.user.id, invite.team.leaderId);

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
