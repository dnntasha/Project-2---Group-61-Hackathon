import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import authRoutes from './routes/auth.js';
import { authenticate } from './lib/sessions.js';
import { runPython } from './lib/pythonRunner.js';

const app = express();
const port = process.env.PORT || 5000;

//default code (when nothing has been changed)
const defaultCode = `def main():
    print("Hello, Hackathon!")

if __name__ == "__main__":
    main()
`;
const rooms = new Map();
const MAX_CODE_BYTES = 256 * 1024;
const MAX_FILES_PER_ROOM = 200;
const ROOM_ID_PATTERN = /^[\w-]{1,64}$/; //REGEX expression
// basically any combination of characters (including numbers) or hyphens that is between 1 and 64 is allowed

function isValidFilePath(filePath) {
  //ensures that the filePath is valid
  // ensures that the path is a string, of suitable length and follows and appropriate format
  return (
    typeof filePath === 'string' &&
    filePath.length > 0 &&
    filePath.length <= 256 &&
    !filePath.includes('\\') &&
    filePath.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

app.use(express.json());

// Express HTTP REST routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

app.use('/api/auth', authRoutes);

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'There has been an error with the server' });
});

// Create HTTP server from Express app
const server = http.createServer(app);

// Initialize WebSocket server attached to HTTP server
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: MAX_CODE_BYTES + 4096,
});

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

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

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

function getFile(room, filePath) {
  let file = room.files.get(filePath);
  if (!file) {
    if (room.files.size >= MAX_FILES_PER_ROOM) return null;
    file = { code: '', revision: 0 };
    room.files.set(filePath, file);
  }
  return file;
}

function broadcastToRoom(room, sender, message) {
  const serialized = JSON.stringify(message);
  for (const client of room.clients) {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  }
}

// Handle WebSocket connections
wss.on('connection', async (ws, req) => {
  const { searchParams } = new URL(req.url, 'http://localhost');
  const token = searchParams.get('token');
  const roomId = searchParams.get('roomId') || 'default-room';

  if (!ROOM_ID_PATTERN.test(roomId)) {
    ws.close(1008, 'Invalid room');
    return;
  }

  try {
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
            if (!(await authenticate(token))) {
              ws.close(4001, 'Unauthorized');
              return;
            }

            if (!data || typeof data.type !== 'string') {
              send(ws, { type: 'ERROR', error: 'Message type is required.' });
              return;
            }

            switch (data.type) {
              case 'SYNC_INIT':
                sendSnapshot(ws, room);
                break;

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
                if (baseRevision !== file.revision) {
                  send(ws, {
                    type: 'FILE_SNAPSHOT',
                    filePath,
                    code: file.code,
                    revision: file.revision,
                  });
                  return;
                }

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

    ws.on('close', () => {
      room.clients.delete(ws);
      console.log(`${ws.user.username} disconnected from room ${roomId}`);
    });
    ws.on('error', (error) => {
      console.error(`WebSocket error for ${ws.user.username}:`, error);
    });
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
