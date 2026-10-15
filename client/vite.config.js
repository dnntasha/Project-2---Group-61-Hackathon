import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Ports can be overridden from the environment so several instances can run
// side by side (e.g. to simulate multiple users):
//   CLIENT_PORT - port the Vite dev server listens on (default 3000)
//   API_PORT    - port of the backend to proxy to; must match the server's
//                 PORT (default 5000)
const clientPort = Number(process.env.CLIENT_PORT) || 3000;
const apiPort = Number(process.env.API_PORT) || 5000;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: clientPort,
    // Serve the client plus the one server module it shares (text
    // operations), rather than the whole repository (incl. the database)
    fs: { allow: ['.', '../server/lib/textOp.js'] },
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://localhost:${apiPort}`,
        ws: true,
      },
    },
  },
});
