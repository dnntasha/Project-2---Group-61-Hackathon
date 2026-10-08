/**
 * Server entry point.
 *
 * Runs a single HTTP server that hosts:
 *  - REST routes under /api (health check, authentication)
 *  - A WebSocket endpoint at /ws for real-time collaborative code editing,
 *    running Python code and (eventually) submitting solutions.
 *
 * Collaboration model: each "room" holds an in-memory set of files. Clients
 * send small text edits (index / inserted text / deleted count) tagged with the
 * revision they were based on. The server accepts an edit only if that revision
 * is the file's current one, bumps the revision and relays the edit to everyone
 * else in the room; otherwise it replies with a full snapshot so the client can
 * resynchronise. Room state is not persisted and is lost on restart.
 */
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import authRoutes from './routes/auth.js';
import { authenticate } from './lib/sessions.js';
import { runPython } from './lib/pythonRunner.js';

const app = express();
const port = process.env.PORT || 5000;

// Starter contents of main.py in a newly created room
const defaultCode = `def main():
    print("Hello, Hackathon!")

if __name__ == "__main__":
    main()
`;

// roomId -> { clients: Set<WebSocket>, files: Map<filePath, { code, revision }> }
const rooms = new Map();
// Upper bound on a single file's size (also used to cap run requests)
const MAX_CODE_BYTES = 256 * 1024;
// Stops a room from being flooded with an unbounded number of files
const MAX_FILES_PER_ROOM = 200;
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

app.use('/api/auth', authRoutes);

// Catch-all error handler: log the details but don't leak them to the client
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

// Returns the room with this ID, creating it with a default main.py if needed

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      clients: new Set(),
      files: new Map([['main.py', { code: defaultCode, revision: 0 }]]),
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
    files,
    revisions: Object.fromEntries(
      [...room.files].map(([filePath, file]) => [filePath, file.revision])
    ),
  });
}

// Returns a file in the room, creating an empty one on first access.
// Returns null if creating it would exceed the room's file limit.
function getFile(room, filePath) {
  let file = room.files.get(filePath);
  if (!file) {
    if (room.files.size >= MAX_FILES_PER_ROOM) return null;
    file = { code: '', revision: 0 };
    room.files.set(filePath, file);
  }
  return file;
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

  try {
    // Custom close code 4001 tells the client its sign-in is invalid/expired
    const auth = await authenticate(token);
    if (!auth) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    ws.user = auth.user;
    ws.roomId = roomId;
    const room = getRoom(roomId);
    room.clients.add(ws);
    console.log(`${ws.user.username} connected to room ${roomId}`);

    // Messages are processed one at a time, in arrival order. Handlers are
    // async (auth check, Python run), so without this queue two edits could
    // interleave and be applied against the wrong revision.
    let messageQueue = Promise.resolve();
    ws.on('message', (message) => {
      messageQueue = messageQueue
        .then(async () => {
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

                const file = getFile(room, data.filePath);
                if (!file) {
                  send(ws, {
                    type: 'ERROR',
                    error: 'The room has reached its file limit.',
                  });
                  return;
                }
                send(ws, {
                  type: 'FILE_SNAPSHOT',
                  filePath: data.filePath,
                  code: file.code,
                  revision: file.revision,
                });
                break;
              }

              // Client reports an edit: replace `deletedCount` chars at `index`
              // with `inserted`, based on revision `baseRevision`
              case 'TEXT_EDIT': {
                const {
                  filePath,
                  index,
                  inserted,
                  deletedCount,
                  baseRevision,
                } = data;
                if (
                  !isValidFilePath(filePath) ||
                  typeof index !== 'number' ||
                  !Number.isInteger(index) ||
                  typeof inserted !== 'string' ||
                  typeof deletedCount !== 'number' ||
                  !Number.isInteger(deletedCount) ||
                  deletedCount < 0 ||
                  typeof baseRevision !== 'number' ||
                  !Number.isInteger(baseRevision)
                ) {
                  send(ws, { type: 'ERROR', error: 'Invalid text edit.' });
                  return;
                }

                const file = getFile(room, filePath);
                if (!file) {
                  send(ws, {
                    type: 'ERROR',
                    error: 'The room has reached its file limit.',
                  });
                  return;
                }
                // Stale edit (client missed an update): send the authoritative
                // snapshot instead of applying it
                if (baseRevision !== file.revision) {
                  send(ws, {
                    type: 'FILE_SNAPSHOT',
                    filePath,
                    code: file.code,
                    revision: file.revision,
                  });
                  return;
                }

                // Apply the edit as a splice, then bounds/size check the result
                const updatedCode =
                  file.code.slice(0, index) +
                  inserted +
                  file.code.slice(index + deletedCount);
                if (
                  index > file.code.length ||
                  index + deletedCount > file.code.length ||
                  Buffer.byteLength(updatedCode, 'utf8') > MAX_CODE_BYTES
                ) {
                  send(ws, {
                    type: 'ERROR',
                    error: 'The edit is invalid or the file is too large.',
                  });
                  return;
                }

                // Commit, bump the revision and relay to everyone else
                // (the sender already applied the edit locally)
                file.code = updatedCode;
                file.revision += 1;
                broadcastToRoom(room, ws, {
                  type: 'TEXT_EDIT',
                  filePath,
                  index,
                  inserted,
                  deletedCount,
                  revision: file.revision,
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
    ws.close(1011, 'Connection setup failed');
  }
});

// Start the HTTP & WebSocket server
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`WebSocket server running on ws://localhost:${port}/ws`);
});
