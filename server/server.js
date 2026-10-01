import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
//import cors from 'cors';
import authRoutes from './routes/auth.js';
import { authenticate } from './lib/sessions.js';

const app = express();
const port = process.env.PORT || 5000;

// Enable CORS
//app.use(cors());
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
    //a message counts as active
    const authValid = await authenticate(token);
    if (!authValid) return ws.close(4001, 'Unauthorised');
    ws.user = auth.user;
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
    console.log('${ws.user.username} disconnected');
  });
});

// Start the HTTP & WebSocket server
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`WebSocket server running on ws://localhost:${port}`);
});
