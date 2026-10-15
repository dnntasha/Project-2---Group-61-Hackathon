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

// Create group
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

// Get groups belonging to the current user
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

// Get pending group invitations for the signed-in user
router.get(
  '/invites/pending',
  wrap(async (req, res) => {
    const invites = await prisma.groupInvite.findMany({
      where: {
        userId: req.user.id,
      },

      include: {
        group: {
          select: {
            id: true,
            name: true,
            iconFile: true,
            startedAt: true,
          },
        },
      },

      orderBy: {
        createdAt: 'desc',
      },
    });

    return res.json({
      invites: invites.map((invite) => ({
        id: invite.id,
        createdAt: invite.createdAt,

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

// Get one group including its members
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

    const members = [];

    members.push({
      id: group.admin.id,
      username: group.admin.username,
      isAdmin: true,
    });

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

// Update group settings
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

// Upload group icon
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
        next(dbErr);
      }
    });
  }
);

// Send group invitation
router.post(
  '/:groupId/invites',
  requireGroupMember,
  requireGroupAdmin,
  requireNotStarted,
  wrap(async (req, res) => {
    const { userId } = req.body;

    if (!Number.isInteger(userId)) {
      return res.status(400).json({
        error: 'A valid user must be selected.',
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: userId,
      },
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found.',
      });
    }

    if (userId === req.group.adminId) {
      return res.status(409).json({
        error: 'The group administrator is already part of the group.',
      });
    }

    const existingMember = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: req.group.id,
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
          groupId: req.group.id,
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
        groupId: req.group.id,
        userId,
      },
    });

    return res.status(201).json(invite);
  })
);

// Start event
router.post(
  '/:groupId/start',
  requireGroupMember,
  requireGroupAdmin,
  requireNotStarted,
  wrap(async (req, res) => {
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

// Accept group invitation
router.post(
  '/invites/:inviteId/accept',
  wrap(async (req, res) => {
    const inviteId = Number(req.params.inviteId);

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
  })
);

// Decline group invitation
router.post(
  '/invites/:inviteId/decline',
  wrap(async (req, res) => {
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
  })
);

export default router;
