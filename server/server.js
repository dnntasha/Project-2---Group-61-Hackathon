/**
 * Server entry point.
 *
 * Runs a single HTTP server that hosts:
 *  - REST routes under /api (health check, authentication)
 *  - A WebSocket endpoint at /ws for real-time collaborative code editing,
 *    running Python code and (eventually) submitting solutions.
 *
 * Collaboration model: each "room" holds an in-memory file tree and the
 * contents of its files. File/folder changes (create, rename, delete, move)
 * are applied to the room's tree by the server and the new tree is sent to
 * everyone in the room. Clients
 * send text operations (see lib/textOp.js) tagged with the file revision they
 * were based on. If other edits landed since that revision, the server
 * transforms the incoming operation over them (operational transformation),
 * applies it, bumps the revision, acknowledges the sender and relays the
 * transformed operation to everyone else in the room. This lets several users
 * type in the same file at once without losing anyone's changes. If an
 * operation can't be reconciled the sender gets a full snapshot to resync.
 * Room state is saved to the database (see lib/roomStore.js): shortly after
 * every change, when the last client leaves, and on shutdown. A room is loaded
 * back from the database the first time someone connects after a restart.
 * Only file contents and the tree are saved; OT revision history is not, so
 * revisions restart from 0 (clients resync from a snapshot on connect).
 *
 * A second WebSocket endpoint, /ws/notifications, carries per-user push events
 * (e.g. "your invites changed") - see lib/notifier.js.
 */
import { setInterval } from 'node:timers';
import express from 'express';
import http from 'http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { securityHeaders } from './middleware/securityHeaders.js';

import { executePython } from './execution/pythonExecutor.js';
import { removeOrphanedContainers } from './execution/dockerSandbox.js';
import authRoutes from './routes/auth.js';
import teamRoutes from './routes/teams.js';
import leaderboardRoutes from './routes/leaderboards.js';
import { authenticate, startSessionCleanup } from './lib/sessions.js';
import { prisma } from './lib/prisma.js';
import {
  allTeamSockets,
  CLOSE_ACCESS_REVOKED,
  registerTeamSocket,
  unregisterTeamSocket,
} from './lib/roomAccess.js';
import { roomToCodebase } from './lib/roomCodebase.js';
import { EVENT_STATUS, getEndsAt, getEventStatus } from './lib/eventTime.js';

import { processSubmission } from './submission/submissionService.js';
import { failInterruptedSubmissions } from './submission/submissionResults.js';
import { runVisibleTests } from './evaluation/codebaseEvaluator.js';
import { applyOp, isValidOp, transform } from './lib/textOp.js';
import { loadRoom, saveRoom } from './lib/roomStore.js';
import { notifyGroup, register, unregister } from './lib/notifier.js';
import invitesRoutes from './routes/invites.js';
import submissionRoutes from './routes/submissions.js';
import { MAIN_STUB, starterTree } from './lib/codebases.js';

// The file-tree rules live next to the client's tree UI so both sides share them.
import {
  applyTreeOperation,
  // createFileNode,
  getFilePathsById,
} from '../client/src/components/FileTree/fileTreeUtils.js';
import groupRoutes, { ICON_DIR } from './routes/groups.js';
import problemRoutes from './routes/problems.js';

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
const port = process.env.PORT || 5000;

if (!process.env.JWT_SECRET) {
  console.error(
    'JWT_SECRET is not set. Add it to server/.env (see .env.example).'
  );
  process.exit(1);
}

// Starter contents of main.py in a newly created room
// const defaultCode = `def main():
//     print("Hello, Hackathon!")

// if __name__ == "__main__":
//     main()
// `;

// roomId -> { clients: Set<WebSocket>, tree, files: Map<filePath, file> }
//  - tree is the room's shared folder structure (see client fileTreeUtils.js);
//    files holds the contents of exactly the file nodes in that tree
// file = { code, revision, history, historyStart }
//  - history[i] is the operation that produced revision historyStart + i + 1
//  - only the most recent MAX_HISTORY operations are kept; a client whose base
//    revision is older than that is resynced with a snapshot
const rooms = new Map();
// Upper bound on a single file's size (also used to cap run requests)
const MAX_CODE_BYTES = 256 * 1024;
// Stops a room from being flooded with an unbounded number of files
const MAX_FILES_PER_ROOM = 200;
const MAX_HISTORY = 1000;
// How often (ms) an open socket re-checks that its session is still valid
const WS_AUTH_RECHECK_MS = 60 * 1000;
// Room IDs may only contain letters, digits, underscores and hyphens (1-64 chars)
const ROOM_ID_PATTERN = /^[\w-]{1,64}$/;
// How often every open socket is re-checked in the background, so a socket
// that never sends anything still loses access when its session expires or its
// user leaves the team
const WS_SWEEP_MS = 30 * 1000;
// How often rooms are checked for the event starting or ending
const EVENT_STATUS_POLL_MS = 2000;
// Message types that change a team's work. They are only accepted while the
// event is running; looking at the room is always allowed.
const MUTATING_MESSAGE_TYPES = new Set([
  'TEXT_EDIT',
  'TREE_OPERATION',
  'RUN_CODE',
  'SUBMIT_SOLUTION',
]);
const EVENT_LOCK_MESSAGES = {
  [EVENT_STATUS.NOT_STARTED]:
    'The event has not started yet, so the code cannot be changed.',
  [EVENT_STATUS.ENDED]:
    'The event has ended, so the code can no longer be changed.',
};
// Browsers can't set headers on a WebSocket, so the session token is sent as a
// subprotocol (`new WebSocket(url, ['bearer', token])`) rather than in the URL,
// where it would end up in proxy and access logs.
const TOKEN_SUBPROTOCOL = 'bearer';

function tokenFromUpgrade(req) {
  const offered = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((protocol) => protocol.trim());
  return offered.length === 2 && offered[0] === TOKEN_SUBPROTOCOL
    ? offered[1]
    : null;
}

function selectTokenSubprotocol(protocols) {
  return protocols.has(TOKEN_SUBPROTOCOL) ? TOKEN_SUBPROTOCOL : false;
}

function isValidFilePath(filePath) {
  // A valid path is a non-empty string of at most 256 characters, uses '/'
  // separators only, and has no empty, '.' or '..' segments (prevents
  // traversal-style paths such as '../x' or 'a//b').
  return (
    typeof filePath === 'string' &&
    filePath.length > 0 &&
    filePath.length <= 256 &&
    !filePath.includes('\\') &&
    filePath.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

// Leaves headroom over MAX_CODE_BYTES for submissions with several files
app.use(express.json({ limit: '1mb' }));

// --- Express HTTP REST routes ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Authentication routes from the shared backend.
app.use('/api/auth', authRoutes);

// Return teams the authenticated user is allowed to collaborate with.
app.get('/api/my-teams', requireAuth, async (req, res) => {
  try {
    const teams = await prisma.team.findMany({
      where: {
        OR: [
          { leaderId: req.user.id },
          { members: { some: { userId: req.user.id } } },
        ],
      },
      select: {
        id: true,
        name: true,
        groupId: true,
        leaderId: true,
        activeProblemId: true,
        group: { select: { name: true, startedAt: true, durationMin: true } },
      },
      orderBy: { id: 'asc' },
    });

    return res.json({ teams });
  } catch (error) {
    console.error('Failed to load user teams:', error);
    return res.status(500).json({
      error: 'Could not load your teams.',
    });
  }
});
// Problems are mounted before groups so their requests don't pass through
// the groups router (and its auth check) first.
app.use('/api/groups/:groupId/problems', problemRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/teams/:teamId/submissions', submissionRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/invites', invitesRoutes);
app.use('/api/leaderboards', leaderboardRoutes);
app.use('/api/uploads/icons', express.static(ICON_DIR));

/**
 * Thando Python execution endpoint.
 *
 * Executes Python code supplied by the client and returns stdout, stderr,
 * exit information, timeout information and runtime data.
 */

// Each run starts a Docker container, so one user can only start so many
const executeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  key: (req) => `execute:${req.user.id}`,
  message: 'You are running code too quickly. Wait a moment and try again.',
});
const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  key: (req) => `submit:${req.user.id}`,
  message: 'You are submitting too quickly. Wait a moment and try again.',
});

app.post('/api/execute', requireAuth, executeLimiter, async (req, res) => {
  if (process.env.ENABLE_PYTHON_EXECUTION !== 'true') {
    return res.status(503).json({
      error: 'Python execution is not yet available.',
    });
  }

  const { code, stdin = '' } = req.body ?? {};

  if (
    typeof code !== 'string' ||
    Buffer.byteLength(code, 'utf8') > 256 * 1024
  ) {
    return res.status(400).json({
      error: 'Python code must be a string of at most 256 KB.',
    });
  }

  if (
    typeof stdin !== 'string' ||
    Buffer.byteLength(stdin, 'utf8') > 64 * 1024
  ) {
    return res.status(400).json({
      error: 'stdin must be a string of at most 64 KB.',
    });
  }

  try {
    const result = await executePython(code, stdin);
    return res.json(result);
  } catch (error) {
    console.error('Python execution failed:', error);

    return res.status(500).json({
      error: 'Failed to execute Python code.',
    });
  }
});

/**
 * Authenticated team submission endpoint.
 *
 * The submission service:
 * - Checks team leadership and problem eligibility.
 * - Loads the team's own saved codebase and validates it.
 * - Atomically reserves an attempt.
 * - Loads trusted test cases from the database.
 * - Evaluates the submitted codebase.
 * - Saves the final grading result.
 *
 * IMPORTANT:
 * Keep this endpoint disabled for untrusted users until
 * the Docker deployment and remaining security checks pass.
 */
app.post('/api/submit', requireAuth, submitLimiter, async (req, res) => {
  if (process.env.ENABLE_SUBMISSION_GRADING !== 'true') {
    return res.status(503).json({
      success: false,
      error: 'Submission grading is not yet available.',
    });
  }
  // The code is never taken from the request: the team's saved room is graded
  const { teamId, problemId } = req.body ?? {};

  if (
    !Number.isInteger(teamId) ||
    teamId <= 0 ||
    !Number.isInteger(problemId) ||
    problemId <= 0
  ) {
    return res.status(400).json({
      success: false,
      error: 'Valid team and problem IDs are required.',
    });
  }

  const room = rooms.get(`team-${teamId}`);
  try {
    const result = await processSubmission({
      userId: req.user.id,
      teamId,
      problemId,
      loadCodebase: () => {
        if (room) {
          broadcastToRoom(room, null, {
            type: 'SUBMISSION_STARTED',
            problemId,
            username: req.user.username,
          });
        }
        return getTeamCodebase(teamId, problemId);
      },
    });

    // Attempted submissions go to the whole room; refusals only to the sender
    if (room && result.submissionId) {
      broadcastToRoom(room, null, {
        type: 'SUBMISSION_RESULT',
        problemId,
        result,
      });
    }

    // A graded submission can change the leaderboards
    if (result.success) {
      const team = await prisma.team.findUnique({
        where: { id: teamId },
        select: { groupId: true },
      });
      if (team) notifyGroup(team.groupId, { type: 'LEADERBOARD_CHANGED' });
    }

    return res.status(result.status).json(result);
  } catch (error) {
    console.error('Submission request failed:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to process submission.',
    });
  }
});

// Unknown API routes get a JSON 404 rather than Express's HTML page
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Production: after `npm run build` the built client in client/dist is served
// by this same server, so one process (and one port) runs the whole site.
// Any other path gets index.html so the client-side router can handle it. In
// development the Vite dev server serves the client instead and none of this
// is used.
const CLIENT_DIST = fileURLToPath(new URL('../client/dist', import.meta.url));
if (existsSync(`${CLIENT_DIST}/index.html`)) {
  app.use(express.static(CLIENT_DIST));
  app.get('*', (req, res) => {
    res.sendFile(`${CLIENT_DIST}/index.html`);
  });
}

// Shared error handler.
// Keep this after the HTTP routes so route errors can reach it.
app.use((err, req, res, _next) => {
  // 4xx errors: body-parser failures (malformed JSON, body too large, which
  // have a `type`) and errors thrown by routes with a status and message
  if (err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({
      error:
        err.type === 'entity.too.large'
          ? 'The request is too large.'
          : err.type
            ? 'The request is invalid.'
            : err.message,
    });
  }
  // Prisma: unique constraint hit by a concurrent request / record gone
  if (err.code === 'P2002') {
    return res.status(409).json({ error: 'That already exists.' });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'Not found.' });
  }
  console.error(err);
  res.status(500).json({ error: 'There has been an error with the server' });
});

// Create HTTP server from Express app (shared by REST and WebSocket)
const server = http.createServer(app);

// Two WebSocket servers share the one HTTP server:
//  - wss:       collaborative editing at /ws
//  - notifyWss: per-user push notifications at /ws/notifications
// The `ws` library's `path` option can only match a single exact path, so both
// are created with `noServer: true` and we route the HTTP "upgrade" request
// ourselves (below) by looking at its URL path.
// maxPayload leaves headroom over the code limit for the JSON envelope.
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_CODE_BYTES + 4096,
  handleProtocols: selectTokenSubprotocol,
});
// Notification clients never need to send anything big
const notifyWss = new WebSocketServer({
  noServer: true,
  maxPayload: 1024,
  handleProtocols: selectTokenSubprotocol,
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const target =
    pathname === '/ws'
      ? wss
      : pathname === '/ws/notifications'
        ? notifyWss
        : null;

  if (!target) {
    // Not one of our endpoints: refuse the upgrade and drop the connection
    socket.destroy();
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => {
    target.emit('connection', ws, req);
  });
});

// Creates the server-side record for a file
function newFile(code) {
  return { code, revision: 0, history: [], historyStart: 0 };
}

// The room a team starts with when nothing has been saved yet
function defaultRoomState() {
  return {
    tree: starterTree(),
    files: new Map([['main.py', newFile(MAIN_STUB)]]),
  };
}

// Builds a room's { tree, files } from what the database has saved, or the
// default starter room if nothing is saved.
async function loadRoomState(teamId, problemId) {
  if (problemId == null) return defaultRoomState();
  const saved = await loadRoom(teamId, problemId);
  if (!saved) return defaultRoomState();

  const files = new Map(
    Object.entries(saved.files).map(([filePath, code]) => [
      filePath,
      newFile(code),
    ])
  );
  // Safety net: every file node in the tree must have contents, otherwise
  // opening it would fail. Give any that are missing an empty file.
  for (const filePath of getFilePathsById(saved.fileTree).values()) {
    if (!files.has(filePath)) files.set(filePath, newFile(''));
  }
  return { tree: saved.fileTree, files };
}

// Rooms currently being loaded from the database: roomId -> Promise<room>.
// Two people connecting at the same instant would otherwise each start a load
// and end up with two separate copies of the same room.
const roomsLoading = new Map();

// Returns the room with this ID, loading it from the database (or creating the
// default one) the first time it is needed. Async because of the database read.
async function getRoom(roomId, teamId, group, problemId) {
  const existing = rooms.get(roomId);
  if (existing) return existing;

  let loading = roomsLoading.get(roomId);
  if (!loading) {
    loading = loadRoomState(teamId, problemId)
      .then((state) => {
        const room = {
          clients: new Set(),
          teamId,
          problemId,
          switching: false, // true while the roomswaps to another problem
          // The group's event timing ({ id, startedAt, durationMin }). Only a
          // group that has not started needs re-reading, see getRoomEventStatus
          group,
          groupCheckedAt: Date.now(),
          eventStatus: getEventStatus(group),
          saveTimer: null, // pending debounced save, if any
          dirty: false, // true when there are changes not yet in the database
          saving: Promise.resolve(), // tail of the chain of save operations
          ...state,
        };
        rooms.set(roomId, room);
        return room;
      })
      .finally(() => roomsLoading.delete(roomId));
    roomsLoading.set(roomId, loading);
  }
  return loading;
}

// How long to wait after the latest edit before writing to the database.
// Typing produces many edits per second; batching them into one write keeps
// the database from being hit on every keystroke.
const SAVE_DEBOUNCE_MS = 1500;

// Writes the room to the database now. Saves for one room are chained so two
// writes can never run at the same time and land out of order.
function saveRoomNow(room) {
  clearTimeout(room.saveTimer);
  room.saveTimer = null;
  if (!room.dirty) return room.saving;
  room.dirty = false;
  //before the event starts there is no codebase to save info
  if (room.problemId == null) return room.saving;

  // Snapshot the state synchronously, before any later edit can change it
  const tree = room.tree;
  const problemId = room.problemId;
  const files = Object.fromEntries(
    [...room.files].map(([filePath, file]) => [filePath, file.code])
  );

  room.saving = room.saving.then(() =>
    saveRoom(room.teamId, problemId, tree, files).catch((error) => {
      // P2025 / P2003: the team was deleted (e.g. its last member left), so
      // there is nothing to save to any more
      if (error.code === 'P2025' || error.code === 'P2003') return;
      console.error(`Failed to save room for team ${room.teamId}:`, error);
      room.dirty = true; // try again with the next save
    })
  );
  return room.saving;
}

// Marks the room as changed and (re)starts the debounce timer. Called after
// every edit; only the last call in a burst actually triggers a save.
function scheduleSave(room) {
  room.dirty = true;
  clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => saveRoomNow(room), SAVE_DEBOUNCE_MS);
}

// Saves every room with unsaved changes and waits for the writes to finish
function flushAllRooms() {
  return Promise.all([...rooms.values()].map((room) => saveRoomNow(room)));
}

// The room's current event status ('not-started', 'running' or 'ended').
// Once the event has started its end time is fixed, so the status is worked
// out from the cached group. Only a group that has not started is re-read from
// the database (at most every EVENT_STATUS_POLL_MS) to notice the admin
// starting it.
async function getRoomEventStatus(room) {
  if (
    !room.group.startedAt &&
    Date.now() - room.groupCheckedAt >= EVENT_STATUS_POLL_MS
  ) {
    room.groupCheckedAt = Date.now();
    const fresh = await prisma.group.findUnique({
      where: { id: room.group.id },
      select: { id: true, startedAt: true, durationMin: true },
    });
    // A deleted group can't be worked on any more
    if (!fresh) return EVENT_STATUS.ENDED;
    room.group = fresh;
  }
  return getEventStatus(room.group);
}

function eventStatusMessage(room, status) {
  return {
    type: 'EVENT_STATUS',
    status,
    endsAt: getEndsAt(room.group)?.toISOString() ?? null,
  };
}

// Tells everyone in a room when the event starts or ends
async function broadcastEventStatusChanges() {
  for (const room of rooms.values()) {
    if (room.clients.size === 0) continue;
    try {
      const status = await getRoomEventStatus(room);
      if (status !== room.eventStatus) {
        room.eventStatus = status;
        //The event started: team's codebase of its first problem
        if (room.problemId == null && status !== EVENT_STATUS.NOT_STARTED) {
          await openActiveProblem(room);
        }
        broadcastToRoom(room, null, eventStatusMessage(room, status));
      }
    } catch (error) {
      console.error('Could not check the event status:', error);
    }
  }
}

// True while this user is the leader or a member of the team
async function isTeamMember(teamId, userId) {
  const team = await prisma.team.findFirst({
    where: {
      id: teamId,
      OR: [{ leaderId: userId }, { members: { some: { userId } } }],
    },
    select: { id: true },
  });
  return Boolean(team);
}

// Closes sockets whose session has expired or whose user has left the team.
// These checks don't count as activity (`touch: false`), so a socket that is
// only receiving teammates' edits can't keep an idle session alive.
async function sweepSockets() {
  const checks = [
    ...allTeamSockets().map(async (ws) => {
      if (!(await authenticate(ws.token, { touch: false }))) {
        ws.close(4001, 'Unauthorized');
      } else if (!(await isTeamMember(ws.teamId, ws.user.id))) {
        ws.close(CLOSE_ACCESS_REVOKED, 'You are no longer on this team.');
      }
    }),
    ...[...notifyWss.clients]
      .filter((ws) => ws.userId !== undefined)
      .map(async (ws) => {
        if (!(await authenticate(ws.token, { touch: false }))) {
          ws.close(4001, 'Unauthorized');
        }
      }),
  ];
  const outcomes = await Promise.allSettled(checks);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      console.error('Socket check failed:', outcome.reason);
    }
  }
}

// The team's saved work as a codebase tree for grading: the live room if
// someone has it open, otherwise what the database holds
async function getTeamCodebase(teamId, problemId) {
  const open = rooms.get(`team-${teamId}`);
  const room =
    open && open.problemId === problemId
      ? open
      : await loadRoomState(teamId, problemId);
  return roomToCodebase(room.tree, room.files);
}

// Leader's choice, else the first problem; null before the event starts
async function resolveActiveProblemId(teamId) {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: {
      activeProblemId: true,
      groupId: true,
      group: { select: { startedAt: true, durationMin: true } },
    },
  });
  if (!team || getEventStatus(team.group) === EVENT_STATUS.NOT_STARTED)
    return null;
  if (team.activeProblemId) return team.activeProblemId;
  const first = await prisma.problem.findFirst({
    where: { groupId: team.groupId },
    orderBy: { orderIndex: 'asc' },
    select: { id: true },
  });
  return first?.id ?? null;
}

// Save the current codebase, load another problem's, send it to every member
async function showProblem(room, problemId) {
  room.switching = true;
  try {
    await room.saving; // earlier saves first
    const next = await loadRoomState(room.teamId, problemId);
    await prisma.team.update({
      where: { id: room.teamId },
      data: { activeProblemId: problemId },
    });
    // synchronous from here: no edit can land between "save old" and "show new"
    const flushed = saveRoomNow(room);
    clearTimeout(room.saveTimer);
    room.saveTimer = null;
    room.dirty = false;
    room.problemId = problemId;
    room.tree = next.tree;
    room.files = next.files;
    for (const client of room.clients) sendSnapshot(client, room);
    await flushed;
  } finally {
    room.switching = false;
  }
}

async function openActiveProblem(room) {
  const problemId = await resolveActiveProblemId(room.teamId);
  if (problemId != null && room.problemId == null)
    await showProblem(room, problemId);
}

// Edits typed into the old problem just before a switch are dropped
function isStaleProblem(room, data) {
  return data.problemId !== undefined && data.problemId !== room.problemId;
}

async function selectProblem(ws, room, problemId) {
  if (!Number.isInteger(problemId))
    return send(ws, { type: 'ERROR', error: 'Choose a problem.' });
  if (problemId === room.problemId) return;
  if (room.switching)
    return send(ws, {
      type: 'ERROR',
      error: 'The problem is already being changed.',
    });
  const team = await prisma.team.findUnique({
    where: { id: room.teamId },
    select: {
      leaderId: true,
      groupId: true,
      group: { select: { startedAt: true, durationMin: true } },
    },
  });
  if (!team || team.leaderId !== ws.user.id)
    return send(ws, {
      type: 'ERROR',
      error: 'Only the team leader can choose the problem.',
    });
  if (getEventStatus(team.group) === EVENT_STATUS.NOT_STARTED)
    return send(ws, {
      type: 'ERROR',
      error: 'Problems can be chosen once the event has started.',
    });
  const problem = await prisma.problem.findUnique({
    where: { id: problemId },
    select: { groupId: true },
  });
  if (!problem || problem.groupId !== team.groupId)
    return send(ws, { type: 'ERROR', error: 'That problem is not available.' });
  await showProblem(room, problemId);
}

// Sends a JSON message to one client, skipping sockets that are no longer open
function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// Sends every file's contents and revision in a room to one client (initial sync)
function sendSnapshot(ws, room) {
  const files = Object.fromEntries(
    [...room.files].map(([filePath, file]) => [filePath, file.code])
  );
  send(ws, {
    type: 'INIT_CODEBASE',
    //what codebase is used for a particular problem
    problemId: room.problemId,
    tree: room.tree,
    files,
    revisions: Object.fromEntries(
      [...room.files].map(([filePath, file]) => [filePath, file.revision])
    ),
  });
}

// Sends one file's authoritative contents and revision to one client
function sendFileSnapshot(ws, filePath, file) {
  send(ws, {
    type: 'FILE_SNAPSHOT',
    filePath,
    code: file.code,
    revision: file.revision,
  });
}

// Sends a message to every client in the room except the sender
function broadcastToRoom(room, sender, message) {
  const serialized = JSON.stringify(message);
  for (const client of room.clients) {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  }
}

// Handle WebSocket connections.
// Clients connect to /ws?roomId=<room>, sending the session token as the
// second WebSocket subprotocol (see tokenFromUpgrade).
wss.on('connection', async (ws, req) => {
  const { searchParams } = new URL(req.url, 'http://localhost');
  const token = tokenFromUpgrade(req);
  const roomId = searchParams.get('roomId') || '';
  let room = null;
  ws.token = token;

  // Attached first so a socket that errors or closes while authentication is
  // still running neither crashes the process nor stays in a room
  ws.on('error', (error) => {
    console.error(`WebSocket error in room ${roomId}:`, error.message);
  });
  ws.on('close', () => {
    if (ws.teamId !== undefined) unregisterTeamSocket(ws.teamId, ws);
    if (!room) return;
    room.clients.delete(ws);
    console.log(`${ws.user.username} disconnected from room ${roomId}`);
    // Don't make the last person to leave wait out the debounce timer
    if (room.clients.size === 0) saveRoomNow(room);
  });

  // Reject malformed room IDs before touching any room state
  if (!ROOM_ID_PATTERN.test(roomId)) {
    ws.close(1008, 'Invalid room');
    return;
  }

  // Messages are processed one at a time, in arrival order. Handlers are
  // async (auth check, Python run), so without this queue two edits could
  // interleave and be applied against the wrong revision.
  // The listener is attached immediately (before authentication finishes) so
  // a message the client sends as soon as the socket opens - e.g. SYNC_INIT -
  // isn't dropped; queued messages wait until `room` has been set up.
  let setupDone;
  let messageQueue = new Promise((resolve) => {
    setupDone = resolve;
  });
  ws.on('message', (message) => {
    messageQueue = messageQueue
      .then(async () => {
        if (!room) return; // authentication failed; the socket is closing
        let data;
        try {
          data = JSON.parse(message.toString());
        } catch {
          ws.close(1003, 'Invalid JSON message');
          return;
        }

        try {
          // Re-validate the session periodically so expired or revoked
          // sessions are cut off without a database hit on every keystroke
          if (Date.now() - ws.authCheckedAt > WS_AUTH_RECHECK_MS) {
            if (!(await authenticate(token))) {
              ws.close(4001, 'Unauthorized');
              return;
            }
            // Membership can change while a socket stays open (the user may
            // have left the team), so it is re-checked along with the session
            if (!(await isTeamMember(ws.teamId, ws.user.id))) {
              ws.close(CLOSE_ACCESS_REVOKED, 'You are no longer on this team.');
              return;
            }
            ws.authCheckedAt = Date.now();
          }

          if (!data || typeof data.type !== 'string') {
            send(ws, { type: 'ERROR', error: 'Message type is required.' });
            return;
          }

          // Work can only change while the event is running
          if (MUTATING_MESSAGE_TYPES.has(data.type)) {
            const status = await getRoomEventStatus(room);
            if (status !== EVENT_STATUS.RUNNING) {
              // filePath lets the client drop a rejected edit and resync
              send(ws, {
                type: 'ERROR',
                filePath: data.type === 'TEXT_EDIT' ? data.filePath : undefined,
                error: EVENT_LOCK_MESSAGES[status],
              });
              return;
            }
          }

          switch (data.type) {
            // Client asks for the full state of the room (sent after connecting)
            case 'SYNC_INIT':
              sendSnapshot(ws, room);
              break;

            // Client opens a file; reply with its current contents and revision
            case 'SELECT_FILE': {
              if (!isValidFilePath(data.filePath)) {
                send(ws, { type: 'ERROR', error: 'Invalid file path.' });
                return;
              }

              const file = room.files.get(data.filePath);
              if (!file) {
                send(ws, { type: 'ERROR', error: 'That file does not exist.' });
                return;
              }
              sendFileSnapshot(ws, data.filePath, file);
              break;
            }

            // Client reports an edit as an operation (see lib/textOp.js)
            // made against file revision `baseRevision`
            case 'TEXT_EDIT': {
              const { filePath, op, baseRevision } = data;
              //Typed into the previous problem's codebase
              if (isStaleProblem(room, data)) return;
              if (
                !isValidFilePath(filePath) ||
                !isValidOp(op) ||
                !Number.isInteger(baseRevision)
              ) {
                // filePath lets the client drop the rejected edit and resync
                send(ws, {
                  type: 'ERROR',
                  filePath,
                  error: 'Invalid text edit.',
                });
                return;
              }

              const file = room.files.get(filePath);
              if (!file) {
                send(ws, {
                  type: 'ERROR',
                  filePath,
                  error: 'That file does not exist.',
                });
                return;
              }

              // The client's base must be a revision we still have history
              // for; otherwise resync it with the current contents
              if (
                baseRevision < file.historyStart ||
                baseRevision > file.revision
              ) {
                sendFileSnapshot(ws, filePath, file);
                return;
              }

              let transformed = op;
              let updatedCode;
              try {
                // Rebase the edit over everything applied since the client's
                // base revision so it fits the current document
                for (const prior of file.history.slice(
                  baseRevision - file.historyStart
                )) {
                  transformed = transform(transformed, prior)[0];
                }
                updatedCode = applyOp(file.code, transformed);
              } catch {
                sendFileSnapshot(ws, filePath, file);
                return;
              }

              if (Buffer.byteLength(updatedCode, 'utf8') > MAX_CODE_BYTES) {
                send(ws, {
                  type: 'ERROR',
                  error: 'The edit makes the file too large.',
                });
                sendFileSnapshot(ws, filePath, file);
                return;
              }

              // Commit and record the operation in the file's history
              file.code = updatedCode;
              file.revision += 1;
              file.history.push(transformed);
              if (file.history.length > MAX_HISTORY) {
                file.history.shift();
                file.historyStart += 1;
              }

              // Confirm to the sender (it has already applied the edit) and
              // relay the rebased operation to everyone else
              scheduleSave(room); // persist the new contents shortly
              send(ws, { type: 'ACK', filePath, revision: file.revision });
              broadcastToRoom(room, ws, {
                type: 'TEXT_EDIT',
                filePath,
                op: transformed,
                revision: file.revision,
              });
              break;
            }

            // Client creates, renames, deletes or moves a file or folder. The
            // server applies it to the room's tree, re-keys file contents to
            // match, and sends the new tree to everyone (including the sender,
            // who waits for it rather than updating optimistically).
            case 'TREE_OPERATION': {
              if (isStaleProblem(room, data)) return;
              const result = applyTreeOperation(room.tree, data.operation);
              if (result.error) {
                send(ws, { type: 'ERROR', error: result.error });
                return;
              }

              const oldPaths = getFilePathsById(room.tree);
              const newPaths = getFilePathsById(result.tree);
              if (
                newPaths.size > MAX_FILES_PER_ROOM ||
                [...newPaths.values()].some((path) => !isValidFilePath(path))
              ) {
                send(ws, {
                  type: 'ERROR',
                  error:
                    'The room has reached its file limit or the path is too long.',
                });
                return;
              }

              // Carry each surviving file's contents to its new path; files
              // that are gone (deleted, or inside a deleted folder) are dropped
              const moved = [];
              for (const [id, oldPath] of oldPaths) {
                const file = room.files.get(oldPath);
                room.files.delete(oldPath);
                if (file && newPaths.has(id))
                  moved.push([newPaths.get(id), file]);
              }
              for (const [path, file] of moved) room.files.set(path, file);
              for (const [id, path] of newPaths) {
                if (!oldPaths.has(id)) room.files.set(path, newFile(''));
              }

              room.tree = result.tree;
              scheduleSave(room); // persist the new structure shortly
              broadcastToRoom(room, null, {
                type: 'TREE_UPDATE',
                tree: room.tree,
              });
              break;
            }

            // Practice run: the room's saved code is run against the problem's
            // visible test cases only (hidden ones are graded on submit). The
            // results go to the requesting client only.
            case 'RUN_CODE': {
              const reply = (fields) =>
                send(ws, {
                  type: 'RUN_RESULTS',
                  requestId: data.requestId,
                  ...fields,
                });

              if (process.env.ENABLE_PYTHON_EXECUTION !== 'true') {
                reply({ error: 'Python execution is disabled.' });
                return;
              }
              if (room.problemId == null) {
                reply({ error: 'No problem is selected for this team yet.' });
                return;
              }
              if (ws.isRunning) {
                reply({
                  error: 'A run is already in progress for this connection.',
                });
                return;
              }

              // Only one run per connection at a time
              ws.isRunning = true;
              const problemId = room.problemId;
              prisma.testCase
                .findMany({
                  where: { problemId, hidden: false },
                  orderBy: { id: 'asc' },
                })
                .then((testCases) =>
                  runVisibleTests(
                    roomToCodebase(room.tree, room.files),
                    testCases
                  )
                )
                .then((results) => reply({ problemId, results }))
                .catch((error) => {
                  console.error('Python execution failed:', error);
                  reply({
                    error:
                      error.code === 'ENOENT'
                        ? 'Docker was not found on the server.'
                        : 'Python execution could not be started.',
                  });
                })
                .finally(() => {
                  ws.isRunning = false;
                });
              break;
            }
            //the leader picks the problem the team will do
            case 'SELECT_PROBLEM':
              await selectProblem(ws, room, data.problemId);
              break;
            // Placeholder until grading is implemented
            case 'SUBMIT_SOLUTION':
              send(ws, {
                type: 'SUBMISSION_UNAVAILABLE',
                message: 'Grading is not available yet.',
              });
              break;

            default:
              send(ws, { type: 'ERROR', error: 'Unsupported message type.' });
          }
        } catch (error) {
          console.error('WebSocket message handling failed:', error);
          send(ws, {
            type: 'ERROR',
            error: 'The request could not be handled.',
          });
        }
      })
      .catch((error) => {
        console.error('WebSocket message queue failed:', error);
        send(ws, {
          type: 'ERROR',
          error: 'The request could not be handled.',
        });
      });
  });

  try {
    // Custom close code 4001 tells the client its sign-in is invalid/expired
    const auth = await authenticate(token);
    if (!auth) {
      ws.close(4001, 'Unauthorized');
      setupDone();
      return;
    }

    // Only team-based collaborative rooms are permitted.
    const match = /^team-([1-9]\d*)$/.exec(roomId);

    if (!match) {
      ws.close(1008, 'A valid team room is required');
      setupDone();
      return;
    }

    const teamId = Number(match[1]);

    if (!Number.isSafeInteger(teamId)) {
      ws.close(1008, 'Invalid team ID');
      setupDone();
      return;
    }

    // Verify that the authenticated user belongs to this team.
    const team = await prisma.team.findFirst({
      where: {
        id: teamId,
        OR: [
          { leaderId: auth.user.id },
          { members: { some: { userId: auth.user.id } } },
        ],
      },
      select: {
        id: true,
        group: { select: { id: true, startedAt: true, durationMin: true } },
      },
    });

    if (!team) {
      ws.close(1008, 'Team access denied');
      setupDone();
      return;
    }

    // The client may have disconnected while we were checking access
    if (ws.readyState !== WebSocket.OPEN) {
      setupDone();
      return;
    }

    ws.user = auth.user;
    ws.roomId = roomId;
    ws.teamId = teamId;
    ws.authCheckedAt = Date.now();
    // Loads the team's saved files from the database on first use
    const problemId = await resolveActiveProblemId(teamId);
    const loadedRoom = await getRoom(roomId, teamId, team.group, problemId);
    // The client may have disconnected during the database read; its close
    // handler already ran (with no room), so don't add a dead socket now
    if (ws.readyState !== WebSocket.OPEN) {
      setupDone();
      return;
    }
    room = loadedRoom;
    room.clients.add(ws);
    registerTeamSocket(teamId, ws);
    console.log(`${ws.user.username} connected to room ${roomId}`);
    setupDone(); // start processing any queued messages

    // Tell the client the connection was accepted, and whether the code can
    // currently be changed
    send(ws, { type: 'WELCOME', message: 'Connected to the editor room.' });
    const status = await getRoomEventStatus(room);
    room.eventStatus = status;
    send(ws, eventStatusMessage(room, status));
  } catch (error) {
    console.error('WebSocket connection setup failed:', error);
    setupDone();
    ws.close(1011, 'Connection setup failed');
  }
});

// Per-user notification sockets: clients connect to
// /ws/notifications, sending the session token as a subprotocol like the
// editor socket. The server only ever pushes to these (see lib/notifier.js);
// anything a client sends is ignored.
notifyWss.on('connection', async (ws, req) => {
  let userId = null;
  ws.token = tokenFromUpgrade(req);

  // Attached before the (async) authentication so a socket that closes or
  // errors mid-way is cleaned up properly and never crashes the process
  ws.on('error', (error) => {
    console.error('Notification socket error:', error.message);
  });
  ws.on('close', () => {
    if (userId !== null) unregister(userId, ws);
  });

  try {
    const auth = await authenticate(ws.token);
    if (!auth) {
      // 4001 tells the client its sign-in is invalid/expired
      ws.close(4001, 'Unauthorized');
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return; // closed while authenticating

    userId = auth.user.id;
    ws.userId = userId;
    register(userId, ws);
  } catch (error) {
    console.error('Notification socket setup failed:', error);
    ws.close(1011, 'Connection setup failed');
  }
});

// On Ctrl+C / `kill`, write any not-yet-saved editor changes before exiting,
// otherwise edits from the last second or so would be lost.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    flushAllRooms()
      .catch((error) => console.error('Failed to flush rooms:', error))
      .finally(() => process.exit(0));
  });
}

// Background checks: idle or revoked sockets are closed, and rooms are told
// when the event starts or ends. unref() so they never keep the process alive.
setInterval(sweepSockets, WS_SWEEP_MS).unref();
setInterval(broadcastEventStatusChanges, EVENT_STATUS_POLL_MS).unref();

// Start the HTTP & WebSocket server
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`WebSocket server running on ws://localhost:${port}/ws`);
  startSessionCleanup();

  // Sandbox containers from a previous run that was stopped mid-execution
  if (
    process.env.ENABLE_PYTHON_EXECUTION === 'true' ||
    process.env.ENABLE_SUBMISSION_GRADING === 'true'
  ) {
    failInterruptedSubmissions()
      .then((failed) => {
        if (failed)
          console.log(`Marked ${failed} interrupted submissions as failed.`);
      })
      .catch((error) => {
        console.error('Could not clean up interrupted submissions:', error);
      });
    removeOrphanedContainers().then((removed) => {
      if (removed)
        console.log(`Removed ${removed} leftover sandbox containers.`);
    });
  }
});
