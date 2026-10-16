import { Router } from 'express';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import {
  hasStarted,
  requireGroupAdmin,
  requireGroupMember,
  requireNotStarted,
} from '../middleware/groups.js';
import { getEndsAt, getEventStatus } from '../lib/eventTime.js';
import { notifyInvitesChanged } from '../lib/notifier.js';
import { hasImageSignature } from '../lib/imageSignature.js';

// Icons are saved in server/uploads/icons and served at /api/uploads/icons.
export const ICON_DIR = fileURLToPath(
  new URL('../uploads/icons', import.meta.url)
);

mkdirSync(ICON_DIR, { recursive: true });

const IMAGE_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: ICON_DIR,
    filename: (req, file, cb) =>
      cb(null, randomUUID() + IMAGE_TYPES[file.mimetype]),
  }),

  limits: {
    fileSize: 2 * 1024 * 1024,
  },

  fileFilter: (req, file, cb) => {
    if (IMAGE_TYPES[file.mimetype]) {
      return cb(null, true);
    }

    cb(new Error('The icon must be a PNG, JPEG, GIF or WebP image.'));
  },
});

const LIMITS = {
  durationMin: {
    min: 10,
    max: 1440,
    label: 'Duration',
  },

  maxTeamSize: {
    min: 1,
    max: 10,
    label: 'Maximum team size',
  },

  topK: {
    min: 1,
    max: 50,
    label: 'Number of scored problems',
  },
};

const router = Router();

router.use(requireAuth);

const wrap = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

function toClient(group, isAdmin) {
  return {
    id: group.id,
    name: group.name,
    iconUrl: group.iconFile ? `/api/uploads/icons/${group.iconFile}` : null,
    isAdmin,
    durationMin: group.durationMin,
    maxTeamSize: group.maxTeamSize,
    topK: group.topK,
    startedAt: group.startedAt,
    endsAt: getEndsAt(group),
    status: getEventStatus(group),
    serverTime: new Date(),
  };
}

function validateName(name) {
  if (typeof name !== 'string') {
    return 'Enter a group name.';
  }

  const trimmed = name.trim();

  if (trimmed.length < 3 || trimmed.length > 40) {
    return 'The group name must be 3–40 characters.';
  }

  return null;
}

// POST /api/groups
// Creates a group and makes the creator the admin.
router.post(
  '/',
  wrap(async (req, res) => {
    const error = validateName(req.body?.name);

    if (error) {
      return res.status(400).json({ error });
    }

    try {
      const group = await prisma.group.create({
        data: {
          name: req.body.name.trim(),
          adminId: req.user.id,
        },
      });

      return res.status(201).json({
        group: toClient(group, true),
      });
    } catch (err) {
      if (err.code === 'P2002') {
        return res.status(409).json({
          error: 'A group with that name already exists.',
        });
      }

      throw err;
    }
  })
);

// GET /api/groups
// Returns groups the current user administers or belongs to.
router.get(
  '/',
  wrap(async (req, res) => {
    const groups = await prisma.group.findMany({
      where: {
        OR: [
          {
            adminId: req.user.id,
          },
          {
            members: {
              some: {
                userId: req.user.id,
              },
            },
          },
        ],
      },

      orderBy: {
        createdAt: 'desc',
      },
    });

    return res.json({
      groups: groups.map((group) =>
        toClient(group, group.adminId === req.user.id)
      ),
    });
  })
);

// GET /api/groups/invites/mine
// Returns pending group invitations for the current user.
router.get(
  '/invites/mine',
  wrap(async (req, res) => {
    const invites = await prisma.groupInvite.findMany({
      where: {
        userId: req.user.id,
      },

      include: {
        group: true,
      },

      orderBy: {
        id: 'desc',
      },
    });

    return res.json({
      invites: invites.map((invite) => ({
        id: invite.id,

        group: {
          id: invite.group.id,
          name: invite.group.name,
          iconUrl: invite.group.iconFile
            ? `/api/uploads/icons/${invite.group.iconFile}`
            : null,
          startedAt: invite.group.startedAt,
        },
      })),
    });
  })
);

// GET /api/groups/:groupId
// Returns one group including its current members.
router.get(
  '/:groupId',
  requireGroupMember,
  wrap(async (req, res) => {
    const group = await prisma.group.findUnique({
      where: {
        id: req.group.id,
      },

      include: {
        admin: {
          select: {
            id: true,
            username: true,
          },
        },

        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
              },
            },
          },

          orderBy: {
            joinedAt: 'asc',
          },
        },
      },
    });

    const members = [
      {
        id: group.admin.id,
        username: group.admin.username,
        isAdmin: true,
      },
    ];

    for (const member of group.members) {
      if (member.user.id === group.admin.id) {
        continue;
      }

      members.push({
        id: member.user.id,
        username: member.user.username,
        joinedAt: member.joinedAt,
        isAdmin: false,
      });
    }

    return res.json({
      group: {
        ...toClient(group, req.isGroupAdmin),
        members,
      },
    });
  })
);

// GET /api/groups/:groupId/members
// Returns the admin, members and, for admins, pending invitations.
router.get(
  '/:groupId/members',
  requireGroupMember,
  wrap(async (req, res) => {
    const groupId = req.group.id;

    const [admin, members, invites] = await Promise.all([
      prisma.user.findUnique({
        where: {
          id: req.group.adminId,
        },
      }),

      prisma.groupMember.findMany({
        where: {
          groupId,
        },

        include: {
          user: true,
        },

        orderBy: {
          id: 'asc',
        },
      }),

      req.isGroupAdmin
        ? prisma.groupInvite.findMany({
            where: {
              groupId,
            },

            include: {
              user: true,
            },

            orderBy: {
              id: 'asc',
            },
          })
        : [],
    ]);

    return res.json({
      admin: {
        id: admin.id,
        username: admin.username,
      },

      members: members.map((member) => ({
        id: member.user.id,
        username: member.user.username,
      })),

      invites: invites.map((invite) => ({
        id: invite.id,
        username: invite.user.username,
      })),
    });
  })
);

// PATCH /api/groups/:groupId/settings
router.patch(
  '/:groupId/settings',
  requireGroupMember,
  requireGroupAdmin,
  requireNotStarted,
  wrap(async (req, res) => {
    const data = {};

    for (const [field, { min, max, label }] of Object.entries(LIMITS)) {
      const value = req.body?.[field];

      if (value === undefined) {
        continue;
      }

      if (!Number.isInteger(value) || value < min || value > max) {
        return res.status(400).json({
          error: `${label} must be a whole number from ${min} to ${max}.`,
        });
      }

      data[field] = value;
    }

    // A team's members plus its pending invitations must always fit within
    // the maximum size, otherwise an invitee could fail to join. So the limit
    // can't be lowered below what any team already has.
    if (data.maxTeamSize !== undefined) {
      const teams = await prisma.team.findMany({
        where: { groupId: req.group.id },
        select: {
          name: true,
          _count: { select: { members: true, invites: true } },
        },
      });

      for (const team of teams) {
        const used = team._count.members + team._count.invites;
        if (used > data.maxTeamSize) {
          return res.status(409).json({
            error: `Team "${team.name}" already has ${used} members and pending invitations. Choose ${used} or more, or ask its leader to cancel invitations first.`,
          });
        }
      }
    }

    const group = await prisma.group.update({
      where: {
        id: req.group.id,
      },

      data,
    });

    return res.json({
      group: toClient(group, true),
    });
  })
);

// POST /api/groups/:groupId/icon
router.post(
  '/:groupId/icon',
  requireGroupMember,
  requireGroupAdmin,
  (req, res, next) => {
    upload.single('icon')(req, res, async (err) => {
      if (err) {
        const error =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'The icon must be 2 MB or smaller.'
            : err.message;

        return res.status(400).json({ error });
      }

      if (!req.file) {
        return res.status(400).json({
          error: 'Choose an image file.',
        });
      }

      try {
        // The browser-supplied Content-Type can be anything, so check the
        // file's own signature before keeping it
        if (!(await hasImageSignature(req.file.path, req.file.mimetype))) {
          await unlink(req.file.path).catch(() => {});
          return res.status(400).json({
            error: 'That file is not a valid PNG, JPEG, GIF or WebP image.',
          });
        }

        const oldFile = req.group.iconFile;

        const group = await prisma.group.update({
          where: {
            id: req.group.id,
          },

          data: {
            iconFile: req.file.filename,
          },
        });

        if (oldFile) {
          await unlink(path.join(ICON_DIR, oldFile)).catch(() => {});
        }

        return res.json({
          group: toClient(group, true),
        });
      } catch (dbErr) {
        // Don't leave the uploaded file behind if it wasn't recorded
        await unlink(req.file.path).catch(() => {});
        next(dbErr);
      }
    });
  }
);

// POST /api/groups/:groupId/invites
// Supports either username or userId.
router.post(
  '/:groupId/invites',
  requireGroupMember,
  requireGroupAdmin,
  requireNotStarted,
  wrap(async (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    const rawId = Number(req.body?.userId);

    if (!username && !Number.isInteger(rawId)) {
      return res.status(400).json({
        error: 'Enter a username or valid user ID to invite.',
      });
    }

    const user = username
      ? await prisma.user.findUnique({
          where: {
            username,
          },
        })
      : await prisma.user.findUnique({
          where: {
            id: rawId,
          },
        });

    if (!user) {
      return res.status(404).json({
        error: 'User not found.',
      });
    }

    const userId = user.id;
    const groupId = req.group.id;

    if (userId === req.group.adminId) {
      return res.status(409).json({
        error: 'The group administrator is already part of the group.',
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

    // Push to the invitee (so their navbar badge and invite list update at
    // once) and to the admin (so their other tabs show the new pending invite)
    notifyInvitesChanged(userId, req.group.adminId);

    return res.status(201).json({
      invite: {
        id: invite.id,
        username: user.username,
      },
    });
  })
);

// DELETE /api/groups/:groupId/invites/:inviteId
// Allows the group admin to cancel an invitation.
router.delete(
  '/:groupId/invites/:inviteId',
  requireGroupMember,
  requireGroupAdmin,
  wrap(async (req, res) => {
    const inviteId = Number(req.params.inviteId);

    if (!Number.isInteger(inviteId)) {
      return res.status(400).json({
        error: 'Invalid invitation.',
      });
    }

    // Look the invite up first: once deleted we couldn't tell whose it was,
    // and we need to tell that user their invite has disappeared
    const invite = await prisma.groupInvite.findFirst({
      where: {
        id: inviteId,
        groupId: req.group.id,
      },
    });

    const { count } = await prisma.groupInvite.deleteMany({
      where: {
        id: inviteId,
        groupId: req.group.id,
      },
    });

    if (!invite || count === 0) {
      return res.status(404).json({
        error: 'Invite not found.',
      });
    }

    notifyInvitesChanged(invite.userId, req.group.adminId);

    return res.json({
      ok: true,
    });
  })
);

// POST /api/groups/:groupId/start
router.post(
  '/:groupId/start',
  requireGroupMember,
  requireGroupAdmin,
  requireNotStarted,
  wrap(async (req, res) => {
    // Dev added this validation. Keep it.
    const problemCount = await prisma.problem.count({
      where: {
        groupId: req.group.id,
      },
    });

    if (problemCount === 0) {
      return res.status(409).json({
        error: 'Add at least one problem before starting the event.',
      });
    }

    if (req.group.topK > problemCount) {
      return res.status(409).json({
        error: `Scored problems (${req.group.topK}) cannot be more than the ${problemCount} problem(s) you have defined.`,
      });
    }

    const { count } = await prisma.group.updateMany({
      where: {
        id: req.group.id,
        startedAt: null,
      },

      data: {
        startedAt: new Date(),
      },
    });

    if (count === 0) {
      return res.status(409).json({
        error: 'The event has already started.',
      });
    }

    const group = await prisma.group.findUnique({
      where: {
        id: req.group.id,
      },
    });

    return res.json({
      group: toClient(group, true),
    });
  })
);

// POST /api/groups/invites/:inviteId/accept
router.post(
  '/invites/:inviteId/accept',
  wrap(async (req, res) => {
    const inviteId = Number(req.params.inviteId);

    if (!Number.isInteger(inviteId)) {
      return res.status(400).json({
        error: 'Invalid invitation.',
      });
    }

    const invite = await prisma.groupInvite.findUnique({
      where: {
        id: inviteId,
      },

      include: {
        group: true,
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

    if (hasStarted(invite.group)) {
      return res.status(409).json({
        error: 'The event has already started, so you cannot join this group.',
      });
    }

    const existingMember = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: invite.groupId,
          userId: req.user.id,
        },
      },
    });

    if (existingMember) {
      await prisma.groupInvite.delete({
        where: {
          id: inviteId,
        },
      });

      return res.status(409).json({
        error: 'You are already a member of this group.',
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

    // Tell the accepter's other tabs (the invite is gone, so the badge must
    // drop), the admin (new member, one fewer pending invite) and the other
    // members (their member list changed)
    const otherMembers = await prisma.groupMember.findMany({
      where: { groupId: invite.groupId },
      select: { userId: true },
    });
    notifyInvitesChanged(
      req.user.id,
      invite.group.adminId,
      ...otherMembers.map((member) => member.userId)
    );

    return res.status(200).json(membership);
  })
);

// POST /api/groups/invites/:inviteId/decline
router.post(
  '/invites/:inviteId/decline',
  wrap(async (req, res) => {
    const inviteId = Number(req.params.inviteId);

    if (!Number.isInteger(inviteId)) {
      return res.status(400).json({
        error: 'Invalid invitation.',
      });
    }

    const invite = await prisma.groupInvite.findUnique({
      where: {
        id: inviteId,
      },
      // The group is needed to find out who the admin is
      include: {
        group: true,
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

    // The decliner's other tabs and the admin (pending list shrank)
    notifyInvitesChanged(req.user.id, invite.group.adminId);

    return res.json({
      message: 'Invitation declined.',
    });
  })
);

export default router;
