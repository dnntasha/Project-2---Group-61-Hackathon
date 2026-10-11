import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { requireAuth } from './middleware/auth.js';
import { prisma } from './lib/prisma.js';

import { executePython } from './execution/pythonExecutor.js';
import authRoutes from './routes/auth.js';
import { authenticate } from './lib/sessions.js';

const app = express();
const port = process.env.PORT || 5000;

app.use(express.json());

// Express HTTP REST routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Authentication routes from the shared backend.
app.use('/api/auth', authRoutes);

/**
 * Thando Python execution endpoint.
 *
 * Executes Python code supplied by the client and returns stdout, stderr,
 * exit information, timeout information and runtime data.
 */
app.post('/api/execute', async (req, res) => {
  const { code, stdin = '' } = req.body;

  if (typeof code !== 'string') {
    return res.status(400).json({
      error: 'Python code must be provided as a string.',
    });
  }

  if (typeof stdin !== 'string') {
    return res.status(400).json({
      error: 'stdin must be provided as a string.',
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
 * Thando submission endpoint.
 *
 * Current integration contract:
 * - codebase contains the project's file/directory tree.
 * - testCases contains the tests belonging to the selected problem.
 * - isLeader determines whether the user may submit.
 * - submissionsUsed/submissionLimit enforce the submission limit.
 *
 * The shared application can later replace these request-body values with
 * authenticated team/problem/database state without changing the evaluator.
 */
app.post('/api/submit', requireAuth, async (req, res) => {
  const { teamId } = req.body;

  if (!Number.isInteger(teamId) || teamId <= 0) {
    return res.status(400).json({
      success: false,
      error: 'A valid team ID is required.',
    });
  }

  try {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      return res.status(404).json({
        success: false,
        error: 'Team not found.',
      });
    }

    if (team.leaderId !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: 'Only the team leader may submit a solution.',
      });
    }

    // Grading remains disabled until trusted problem test cases,
    // submission limits and persistence are integrated.
    return res.status(503).json({
      success: false,
      error: 'Submission grading is not yet available.',
    });
  } catch (error) {
    console.error('Submission failed:', error);

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

// Create HTTP server from Express app
const server = http.createServer(app);

// Initialize WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server, path: '/ws' });

// Handle WebSocket connections
wss.on('connection', async (ws, req) => {
  const token = new URL(req.url, 'http://localhost').searchParams.get('token');
  const auth = await authenticate(token);

  if (!auth) return ws.close(4001, 'Unauthorised, FLEE!');

  ws.user = auth.user;
  console.log(`${ws.user.username}, You are now connected`);

  // Send a welcome message to the newly connected client
  ws.send(
    JSON.stringify({
      type: 'WELCOME',
      message: 'Connected to WebSocket server!',
    })
  );

  // Listen for messages from client
  ws.on('message', async (message) => {
    // A message counts as active.
    const authValid = await authenticate(token);
    if (!authValid) return ws.close(4001, 'Unauthorised');

    try {
      const data = JSON.parse(message);
      console.log('Received:', data);

      // Broadcast message to all connected clients
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(data));
        }
      });
    } catch (err) {
      console.error('Failed to parse message:', err);
    }
  });

  // Handle disconnect
  ws.on('close', () => {
    console.log(`${ws.user.username} disconnected`);
  });
});

// Start the HTTP & WebSocket server
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`WebSocket server running on ws://localhost:${port}/ws`);
});
