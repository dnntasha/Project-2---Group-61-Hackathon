//this will be implemented after the requireAuth
import { prisma } from '../lib/prisma.js';

export const hasStarted = (group) => group.startedAt !== null;

//Groups are loaded anf checks if a user is admin or a member

export async function requireGroupMember(req, res, next) {
  try {
    const groupId = Number(req.params.groupId);
    const group = Number.isInteger(groupId)
      ? await prisma.group.findUnique({ where: { id: groupId } })
      : null;

    const isAdmin = Boolean(group) && group.adminId === req.user.id;
    const isMember =
      isAdmin ||
      (Boolean(group) &&
        Boolean(
          await prisma.groupMember.findUnique({
            where: { groupId_userId: { groupId, userId: req.user.id } },
          })
        ));

    if (!isMember)
      return res.status(404).json({ error: "Can't find this group :((" });

    req.group = group;
    req.isGroupAdmin = isAdmin;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireGroupAdmin(req, res, next) {
  if (!req.isGroupAdmin) {
    return res.status(403).json({
      error: "You're not admin...(-_-)Only Admin has this permission. ",
    });
  }
  next();
}

export function requireNotStarted(req, res, next) {
  if (hasStarted(req.group)) {
    return res
      .status(409)
      .json({ error: "The event has started, so you can't change this." });
  }
  next();
}
