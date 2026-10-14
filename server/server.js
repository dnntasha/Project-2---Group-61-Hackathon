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
 * Room state is not persisted and is lost on restart.
 */
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { requireAuth } from './middleware/auth.js';

import { executePython } from './execution/pythonExecutor.js';
import authRoutes from './routes/auth.js';
import { authenticate } from './lib/sessions.js';
import { prisma } from './lib/prisma.js';

import { processSubmission } from './submission/submissionService.js';
import { runPython } from './lib/pythonRunner.js';
import { applyOp, isValidOp, transform } from './lib/textOp.js';

// The file-tree rules live next to the client's tree UI so both sides share them.
import {
  applyTreeOperation,
  createFileNode,
  getFilePathsById,
} from '../client/src/components/FileTree/fileTreeUtils.js';

const app = express();
const port = process.env.PORT || 5000;

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

app.use(express.json());

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

// Shared error handler.
// Keep this after the HTTP routes so route errors can reach it.
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'There has been an error with the server' });
});

// Create HTTP server from Express app (shared by REST and WebSocket)
const server = http.createServer(app);

// Initialize WebSocket server attached to HTTP server.
// maxPayload leaves headroom over the code limit for the JSON envelope.
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: MAX_CODE_BYTES + 4096,
});

// Creates the server-side record for a file
function newFile(code) {
  return { code, revision: 0, history: [], historyStart: 0 };
}

// Returns the room with this ID, creating it with a default main.py if needed

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      clients: new Set(),
      tree: {
        id: 'root',
        name: 'Code',
        type: 'directory',
        children: [createFileNode('main.py')],
      },
      files: new Map([['main.py', newFile(defaultCode)]]),
    };
    rooms.set(roomId, room);
  }
  return room;
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
  const roomId = searchParams.get('roomId') || 'default-room';

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
  let room = null;
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
          // Re-validate the session on every message so expired or revoked
          // sessions are cut off immediately
          if (!(await authenticate(token))) {
            ws.close(4001, 'Unauthorized');
            return;
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
                send(ws, { type: 'ERROR', error: 'Invalid text edit.' });
                return;
              }

              const file = room.files.get(filePath);
              if (!file) {
                send(ws, { type: 'ERROR', error: 'That file does not exist.' });
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
                        ? 'Python was not found. Install Python or set PYTHON_EXECUTABLE.'
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

    ws.user = auth.user;
    ws.roomId = roomId;
    room = getRoom(roomId);
    room.clients.add(ws);
    console.log(`${ws.user.username} connected to room ${roomId}`);
    setupDone(); // start processing any queued messages

    // Remove the client from the room when it disconnects
    ws.on('close', () => {
      room.clients.delete(ws);
      console.log(`${ws.user.username} disconnected from room ${roomId}`);
    });
    ws.on('error', (error) => {
      console.error(`WebSocket error for ${ws.user.username}:`, error);
    });
    // Tell the client the connection was accepted
    send(ws, { type: 'WELCOME', message: 'Connected to the editor room.' });
  } catch (error) {
    console.error('WebSocket connection setup failed:', error);
    setupDone();
    ws.close(1011, 'Connection setup failed');
  }
});

// Start the HTTP & WebSocket server
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`WebSocket server running on ws://localhost:${port}/ws`);
});
