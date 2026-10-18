/**
 * Registry of open editor WebSockets, grouped by team.
 *
 * server.js registers a socket here once it has joined a team's room. Route
 * files (which can't import server.js) use it to cut people off the moment
 * they stop being allowed in: a member who leaves a team, or a team that is
 * deleted. Otherwise a socket opened earlier would keep read and write access
 * to the room until it happened to disconnect.
 */

// Custom WebSocket close code: this user may no longer use this team's room
export const CLOSE_ACCESS_REVOKED = 4003;

// teamId -> Set of open editor sockets for that team
const sockets = new Map();

export function registerTeamSocket(teamId, ws) {
  if (!sockets.has(teamId)) sockets.set(teamId, new Set());
  sockets.get(teamId).add(ws);
}

export function unregisterTeamSocket(teamId, ws) {
  const teamSockets = sockets.get(teamId);
  if (!teamSockets) return;
  teamSockets.delete(ws);
  if (teamSockets.size === 0) sockets.delete(teamId);
}

// Every open editor socket, for periodic checks
export function allTeamSockets() {
  return [...sockets.values()].flatMap((teamSockets) => [...teamSockets]);
}

// Closes the editor sockets one user has open on one team
export function removeUserFromTeamRoom(teamId, userId) {
  for (const ws of sockets.get(teamId) ?? []) {
    if (ws.user?.id === userId) {
      ws.close(CLOSE_ACCESS_REVOKED, 'You are no longer on this team.');
    }
  }
}

// Closes every editor socket of a team (used when the team is deleted)
export function closeTeamRoom(teamId) {
  for (const ws of sockets.get(teamId) ?? []) {
    ws.close(CLOSE_ACCESS_REVOKED, 'This team no longer exists.');
  }
}
