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
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { requireAuth } from './middleware/auth.js';

import { executePython } from './execution/pythonExecutor.js';
import { removeOrphanedContainers } from './execution/dockerSandbox.js';
import authRoutes from './routes/auth.js';
import teamRoutes from './routes/teams.js';
import leaderboardRoutes from './routes/leaderboards.js';
import { authenticate } from './lib/sessions.js';
import { prisma } from './lib/prisma.js';

import { processSubmission } from './submission/submissionService.js';
import { failInterruptedSubmissions } from './submission/submissionResults.js';
import { runPython } from './lib/pythonRunner.js';
import { applyOp, isValidOp, transform } from './lib/textOp.js';
import { loadRoom, saveRoom } from './lib/roomStore.js';
import { register, unregister } from './lib/notifier.js';
import invitesRoutes from './routes/invites.js';

// The file-tree rules live next to the client's tree UI so both sides share them.
import {
  applyTreeOperation,
  createFileNode,
  getFilePathsById,
} from '../client/src/components/FileTree/fileTreeUtils.js';
import groupRoutes, { ICON_DIR } from './routes/groups.js';
import problemRoutes from './routes/problems.js';

const app = express();
const port = process.env.PORT || 5000;

if (!process.env.JWT_SECRET) {
  console.error(
    'JWT_SECRET is not set. Add it to server/.env (see .env.example).'
  );
  process.exit(1);
}

// Starter contents of main.py in a newly created room
const defaultCode = `def main():
    print("Hello, Hackathon!")

if __name__ == "__main__":
    main()
`;

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
        group: { select: { name: true } },
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

app.post('/api/execute', requireAuth, async (req, res) => {
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
 * - Validates the codebase.
 * - Checks team leadership and problem eligibility.
 * - Atomically reserves an attempt.
 * - Loads trusted test cases from the database.
 * - Evaluates the submitted codebase.
 * - Saves the final grading result.
 *
 * IMPORTANT:
 * Keep this endpoint disabled for untrusted users until
 * the Docker deployment and remaining security checks pass.
 */
app.post('/api/submit', requireAuth, async (req, res) => {
  if (process.env.ENABLE_SUBMISSION_GRADING !== 'true') {
    return res.status(503).json({
      success: false,
      error: 'Submission grading is not yet available.',
    });
  }
  const { teamId, problemId, codebase } = req.body;

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

  try {
    const result = await processSubmission({
      userId: req.user.id,
      teamId,
      problemId,
      codebase,
    });

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
});
// Notification clients never need to send anything big
const notifyWss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

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
    tree: {
      id: 'root',
      name: 'Code',
      type: 'directory',
      children: [createFileNode('main.py')],
    },
    files: new Map([['main.py', newFile(defaultCode)]]),
  };
}

// Builds a room's { tree, files } from what the database has saved, or the
// default starter room if nothing is saved.
async function loadRoomState(teamId) {
  const saved = await loadRoom(teamId);
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
async function getRoom(roomId, teamId) {
  const existing = rooms.get(roomId);
  if (existing) return existing;

  let loading = roomsLoading.get(roomId);
  if (!loading) {
    loading = loadRoomState(teamId)
      .then((state) => {
        const room = {
          clients: new Set(),
          teamId,
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

  // Snapshot the state synchronously, before any later edit can change it
  const tree = room.tree;
  const files = Object.fromEntries(
    [...room.files].map(([filePath, file]) => [filePath, file.code])
  );

  room.saving = room.saving.then(() =>
    saveRoom(room.teamId, tree, files).catch((error) => {
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
// Clients connect to /ws?token=<session token>&roomId=<room>.
wss.on('connection', async (ws, req) => {
  const { searchParams } = new URL(req.url, 'http://localhost');
  const token = searchParams.get('token');
  const roomId = searchParams.get('roomId') || '';
  let room = null;

  // Attached first so a socket that errors or closes while authentication is
  // still running neither crashes the process nor stays in a room
  ws.on('error', (error) => {
    console.error(`WebSocket error in room ${roomId}:`, error.message);
  });
  ws.on('close', () => {
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
            ws.authCheckedAt = Date.now();
          }

          if (!data || typeof data.type !== 'string') {
            send(ws, { type: 'ERROR', error: 'Message type is required.' });
            return;
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

            // Execute the supplied Python source in the sandboxed runner and
            // return stdout/stderr to the requesting client only
            case 'RUN_CODE': {
              if (typeof data.code !== 'string') {
                send(ws, {
                  type: 'RUN_RESULTS',
                  requestId: data.requestId,
                  error: 'Python source code is required.',
                });
                return;
              }
              if (Buffer.byteLength(data.code, 'utf8') > MAX_CODE_BYTES) {
                send(ws, {
                  type: 'RUN_RESULTS',
                  requestId: data.requestId,
                  error: 'Code exceeds the 256 KB limit.',
                });
                return;
              }
              if (ws.isRunning) {
                send(ws, {
                  type: 'RUN_RESULTS',
                  requestId: data.requestId,
                  error: 'A run is already in progress for this connection.',
                });
                return;
              }

              // Only one run per connection at a time
              ws.isRunning = true;
              runPython(data.code)
                .then((result) => {
                  send(ws, {
                    type: 'RUN_RESULTS',
                    requestId: data.requestId,
                    ...result,
                  });
                })
                .catch((error) => {
                  console.error('Python execution failed:', error);
                  send(ws, {
                    type: 'RUN_RESULTS',
                    requestId: data.requestId,
                    error:
                      error.code === 'ENOENT'
                        ? 'Docker was not found on the server.'
                        : error.message === 'Python execution is disabled.'
                          ? error.message
                          : 'Python execution could not be started.',
                  });
                })
                .finally(() => {
                  ws.isRunning = false;
                });
              break;
            }

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
      select: { id: true },
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
    ws.authCheckedAt = Date.now();
    // Loads the team's saved files from the database on first use
    const loadedRoom = await getRoom(roomId, teamId);
    // The client may have disconnected during the database read; its close
    // handler already ran (with no room), so don't add a dead socket now
    if (ws.readyState !== WebSocket.OPEN) {
      setupDone();
      return;
    }
    room = loadedRoom;
    room.clients.add(ws);
    console.log(`${ws.user.username} connected to room ${roomId}`);
    setupDone(); // start processing any queued messages

    // Tell the client the connection was accepted
    send(ws, { type: 'WELCOME', message: 'Connected to the editor room.' });
  } catch (error) {
    console.error('WebSocket connection setup failed:', error);
    setupDone();
    ws.close(1011, 'Connection setup failed');
  }
});

// Per-user notification sockets: clients connect to
// /ws/notifications?token=<session token>. The server only ever pushes to
// these (see lib/notifier.js); anything a client sends is ignored.
notifyWss.on('connection', async (ws, req) => {
  const { searchParams } = new URL(req.url, 'http://localhost');
  let userId = null;

  // Attached before the (async) authentication so a socket that closes or
  // errors mid-way is cleaned up properly and never crashes the process
  ws.on('error', (error) => {
    console.error('Notification socket error:', error.message);
  });
  ws.on('close', () => {
    if (userId !== null) unregister(userId, ws);
  });

  try {
    const auth = await authenticate(searchParams.get('token'));
    if (!auth) {
      // 4001 tells the client its sign-in is invalid/expired
      ws.close(4001, 'Unauthorized');
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return; // closed while authenticating

    userId = auth.user.id;
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

// Start the HTTP & WebSocket server
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`WebSocket server running on ws://localhost:${port}/ws`);

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
