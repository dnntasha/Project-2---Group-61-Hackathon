import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { executePython } from './execution/pythonExecutor.js';
import { processSubmission } from './submission/submissionService.js';

const app = express();
const port = process.env.PORT || 5000;

// Enable CORS
app.use(cors());
app.use(express.json());

// Express HTTP REST routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

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

app.post('/api/submit', async (req, res) => {
  const {
    codebase,
    testCases,
    isLeader,
    submissionsUsed = 0,
    submissionLimit,
  } = req.body;

  try {
    const result = await processSubmission({
      codebase,
      testCases,
      isLeader,
      submissionsUsed,
      submissionLimit,
    });

    return res.status(result.status).json(result);
  } catch (error) {
    console.error('Submission failed:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to process submission.',
    });
  }
});

// Create HTTP server from Express app
const server = http.createServer(app);

// Initialize WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server });

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('Client connected');

  // Send a welcome message to the newly connected client
  ws.send(
    JSON.stringify({
      type: 'WELCOME',
      message: 'Connected to WebSocket server!',
    })
  );

  // Listen for messages from client
  ws.on('message', (message) => {
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
    console.log('Client disconnected');
  });
});

// Start the HTTP & WebSocket server
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`WebSocket server running on ws://localhost:${port}`);
});
