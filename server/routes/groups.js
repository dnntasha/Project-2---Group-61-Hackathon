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

// Allowed image types and the extension each is saved with.
// SVG is left out on purpose: it can contain scripts.
const IMAGE_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: ICON_DIR,
    // Random name, so users can't overwrite each other's files or guess names.
    filename: (req, file, cb) =>
      cb(null, randomUUID() + IMAGE_TYPES[file.mimetype]),
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (req, file, cb) => {
    if (IMAGE_TYPES[file.mimetype]) return cb(null, true);
    cb(new Error('The icon must be a PNG, JPEG, GIF or WebP image.'));
  },
});

const LIMITS = {
  durationMin: { min: 10, max: 1440, label: 'Duration' },
  maxTeamSize: { min: 1, max: 10, label: 'Maximum team size' },
  topK: { min: 1, max: 50, label: 'Number of scored problems' },
};

const router = Router();
router.use(requireAuth); // every group route needs a signed-in user

// Express 4 doesn't catch errors in async handlers, so pass them to next().
const wrap = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

// The shape of a group sent to the client.
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
  if (typeof name !== 'string') return 'Enter a group name.';
  const trimmed = name.trim();
  if (trimmed.length < 3 || trimmed.length > 40) {
    return 'The group name must be 3–40 characters.';
  }
  return null;
}

// POST /api/groups { name } - the creator becomes the admin.
router.post(
  '/',
  wrap(async (req, res) => {
    const error = validateName(req.body?.name);
    if (error) return res.status(400).json({ error });

    try {
      const group = await prisma.group.create({
        data: { name: req.body.name.trim(), adminId: req.user.id },
      });
      res.status(201).json({ group: toClient(group, true) });
    } catch (err) {
      if (err.code === 'P2002') {
        return res
          .status(409)
          .json({ error: 'A group with that name already exists.' });
      }
      throw err;
    }
  })
);

// GET /api/groups - groups the user runs or belongs to.
router.get(
  '/',
  wrap(async (req, res) => {
    const groups = await prisma.group.findMany({
      where: {
        OR: [
          { adminId: req.user.id },
          { members: { some: { userId: req.user.id } } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      groups: groups.map((g) => toClient(g, g.adminId === req.user.id)),
    });
  })
);

// GET /api/groups/:groupId
router.get('/:groupId', requireGroupMember, (req, res) => {
  res.json({ group: toClient(req.group, req.isGroupAdmin) });
});

// PATCH /api/groups/:groupId/settings { durationMin, maxTeamSize, topK }
router.patch(
  '/:groupId/settings',
  requireGroupMember,
  requireGroupAdmin,
  requireNotStarted,
  wrap(async (req, res) => {
    const data = {};
    for (const [field, { min, max, label }] of Object.entries(LIMITS)) {
      const value = req.body?.[field];
      if (value === undefined) continue; // only update what was sent
      if (!Number.isInteger(value) || value < min || value > max) {
        return res.status(400).json({
          error: `${label} must be a whole number from ${min} to ${max}.`,
        });
      }
      data[field] = value;
    }

    const group = await prisma.group.update({
      where: { id: req.group.id },
      data,
    });
    res.json({ group: toClient(group, true) });
  })
);

// POST /api/groups/:groupId/icon - multipart form with an "icon" file field.
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
        return res.status(400).json({ error: 'Choose an image file.' });
      }

      try {
        const oldFile = req.group.iconFile;
        const group = await prisma.group.update({
          where: { id: req.group.id },
          data: { iconFile: req.file.filename },
        });
        // Remove the previous icon so old files don't pile up.
        if (oldFile) {
          await unlink(path.join(ICON_DIR, oldFile)).catch(() => {});
        }
        res.json({ group: toClient(group, true) });
      } catch (dbErr) {
        next(dbErr);
      }
    });
  }
);

//POST /api/groups/:groupId/start - admin starts the event
router.post(
  '/:groupId/start',
  requireGroupMember,
  requireGroupAdmin,
  requireNotStarted,
  wrap(async (req, res) => {
    // An event with no problems can't be competed in, and topK is the number of
    // problem scores that count, so it can't exceed how many problems there are.
    const problemCount = await prisma.problem.count({
      where: { groupId: req.group.id },
    });
    if (problemCount === 0) {
      return res
        .status(409)
        .json({ error: 'Add at least one problem before starting the event.' });
    }
    if (req.group.topK > problemCount) {
      return res.status(409).json({
        error: `Scored problems (${req.group.topK}) cannot be more than the ${problemCount} problem(s) you have defined.`,
      });
    }

    // Only update if it still hasn't started, so a double-click can't move the start time.
    const { count } = await prisma.group.updateMany({
      where: { id: req.group.id, startedAt: null },
      data: { startedAt: new Date() },
    });
    if (count === 0) {
      return res.status(409).json({ error: 'The event has already started.' });
    }

    const group = await prisma.group.findUnique({
      where: { id: req.group.id },
    });
    res.json({ group: toClient(group, true) });
  })
);

// Send a group invite for admin to start eh event
router.post(
  '/:groupId/invites',
  requireGroupMember,
  requireGroupAdmin,
  requireNotStarted,
  wrap(async (req, res) => {
    const userId = Number(req.body?.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'A user must be selected.' });
    }

    const groupId = req.group.id;

    if (userId === req.group.adminId) {
      return res
        .status(400)
        .json({ error: 'You are already the admin of this group.' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'That user does not exist.' });
    }

    const existingMember = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (existingMember) {
      return res
        .status(409)
        .json({ error: 'This user is already a member of the group.' });
    }

    const existingInvite = await prisma.groupInvite.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (existingInvite) {
      return res
        .status(409)
        .json({ error: 'This user already has an invitation to the group.' });
    }

    const invite = await prisma.groupInvite.create({
      data: { groupId, userId },
    });
    res.status(201).json(invite);
  })
);

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
