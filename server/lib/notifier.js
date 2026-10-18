/**
 * Registry of every open "notifications" WebSocket, grouped by user.
 *
 * The editor sockets in server.js are tied to a room. These are different:
 * each signed-in browser tab opens one per-user socket so the server can push
 * small events (currently just "your invites changed") the moment something
 * happens, instead of the page having to be refreshed.
 *
 * Route files import `notifyUser` to push an event; server.js calls
 * `register` / `unregister` as sockets connect and disconnect.
 */
import { WebSocket } from 'ws';
import { prisma } from './prisma.js';

// userId -> Set of that user's open sockets. A Set because the same person can
// have several tabs or devices open at once and all of them should be told.
const sockets = new Map();

// Starts delivering events for `userId` to this socket
export function register(userId, ws) {
  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId).add(ws);
}

// Stops delivering events to this socket (call when it closes)
export function unregister(userId, ws) {
  const userSockets = sockets.get(userId);
  if (!userSockets) return;
  userSockets.delete(ws);
  // Drop the empty Set so the Map doesn't grow forever
  if (userSockets.size === 0) sockets.delete(userId);
}

// Sends `event` (a plain object) to every open socket of the given user.
// Safe to call for users who aren't online: it simply does nothing.
export function notifyUser(userId, event) {
  const userSockets = sockets.get(userId);
  if (!userSockets) return;
  const message = JSON.stringify(event);
  for (const ws of userSockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
  }
}

// The only event type so far. The payload is deliberately tiny: the client
// reacts by re-fetching the real data over the normal authenticated REST API,
// so the socket never carries anything sensitive.
export function notifyInvitesChanged(...userIds) {
  for (const userId of new Set(userIds)) {
    notifyUser(userId, { type: 'INVITES_CHANGED' });
  }
}

/**
 * Sends `event` to the admin and every member of a group, e.g.
 * { type: 'GROUP_CHANGED' } when the event starts, { type: 'TEAMS_CHANGED' }
 * when a team is created/joined/left and { type: 'LEADERBOARD_CHANGED' }
 * after a submission is graded. Never throws: a failed notification must not
 * fail the request that triggered it.
 */
export async function notifyGroup(groupId, event) {
  try {
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      select: { adminId: true, members: { select: { userId: true } } },
    });
    if (!group) return;
    const userIds = new Set([
      group.adminId,
      ...group.members.map((member) => member.userId),
    ]);
    for (const userId of userIds) {
      notifyUser(userId, { ...event, groupId });
    }
  } catch (error) {
    console.error('Could not send group notification:', error);
  }
}
